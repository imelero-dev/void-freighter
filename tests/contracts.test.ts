import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { padPoint } from '../src/sim/docking';
import { v3 } from '../src/sim/vec';

function runTicks(sim: Sim, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...sim.tick());
  return events;
}

describe('contract boards', () => {
  it('every station gets a board of valid offers', () => {
    const sim = new Sim();
    for (const st of sim.system.stations) {
      const board = sim.boardFor(st.id);
      expect(board.length).toBeGreaterThanOrEqual(4);
      for (const c of board) {
        expect(c.reward).toBeGreaterThan(0);
        expect(c.deadline).toBeGreaterThan(sim.time);
        if (c.type === 'transport' || c.type === 'urgent') {
          expect(sim.station(c.dest)).toBeTruthy();
          expect(c.dest).not.toBe(st.id);
          expect(c.good).toBeTruthy();
          expect(c.qty).toBeGreaterThan(0);
        }
        if (c.type === 'bounty') {
          expect(c.killsRequired).toBeGreaterThan(0);
          expect(sim.fieldById(c.pirateZone!)).toBeTruthy();
        }
      }
    }
  });

  it('boards refresh over time', () => {
    const sim = new Sim();
    const before = sim.boardFor('morrow_granary').map((c) => c.id);
    // advance past the refresh interval
    for (let i = 0; i < 20 * 250; i++) sim.tick();
    const after = sim.boardFor('morrow_granary').map((c) => c.id);
    expect(after).not.toEqual(before);
  });
});

describe('transport contract lifecycle', () => {
  it('accept reserves sealed cargo; delivery pays out and grants rep', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('courier');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    meta.profile.reputation = { helion: 50, meridian: 50, outwarden: 50, drift: 50, scrappers: 50 };
    const board = sim.boardFor('morrow_granary');
    const c = board.find((k) => (k.type === 'transport' || k.type === 'urgent') && k.qty <= 16)!;
    expect(c).toBeTruthy();
    sim.acceptContract(pid, c.id);
    expect(meta.profile.contracts.length).toBe(1);
    const sealed = meta.profile.cargo.find((ci) => ci.contractId === c.id);
    expect(sealed).toBeTruthy();
    expect(sealed!.qty).toBe(c.qty);

    // sealed cargo cannot be sold
    sim.sellGood(pid, c.good!, c.qty);
    expect(meta.profile.cargo.find((ci) => ci.contractId === c.id)).toBeTruthy();

    // teleport onto the destination's hangar pad and let it dock
    const dest = sim.station(c.dest)!;
    sim.undock(pid);
    sim.meta(pid)!.undockInvuln = 0;
    sim.meta(pid)!.gearDown = true;
    sim.meta(pid)!.vtol = true;
    e.pos = padPoint(dest);
    e.vel = v3();
    const creditsBefore = meta.profile.credits;
    runTicks(sim, 20 * 6);
    expect(e.dockedAt).toBe(dest.id);
    expect(meta.profile.contracts.length).toBe(0);
    expect(meta.profile.credits).toBe(creditsBefore + c.reward);
    expect(meta.profile.reputation[c.factionId]).toBeGreaterThan(0);
    expect(meta.profile.cargo.find((ci) => ci.contractId === c.id)).toBeUndefined();
  });

  it('expired contracts fail, cargo is repossessed and rep drops', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('lazy');
    const meta = sim.meta(pid)!;
    meta.profile.reputation = { helion: 50, meridian: 50, outwarden: 50, drift: 50, scrappers: 50 };
    const board = sim.boardFor('morrow_granary');
    const c = board.find((k) => (k.type === 'transport' || k.type === 'urgent') && k.qty <= 16)!;
    sim.acceptContract(pid, c.id);
    const accepted = meta.profile.contracts[0];
    accepted.deadline = sim.time - 1;
    const events = runTicks(sim, 25);
    expect(meta.profile.contracts.length).toBe(0);
    expect(meta.profile.cargo.length).toBe(0);
    expect(meta.profile.reputation[c.factionId]).toBeLessThan(50); // dropped from 50
    expect(events.some((ev) => ev.type === 'contractFailed')).toBe(true);
  });

  it('cannot accept without cargo space', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('full');
    const meta = sim.meta(pid)!;
    meta.profile.reputation = { helion: 50, meridian: 50, outwarden: 50, drift: 50, scrappers: 50 };
    sim.addCargo(meta.profile, 'machinery', 200); // overfill (volume 1.8 each)
    const board = sim.boardFor('morrow_granary');
    const c = board.find((k) => k.type === 'transport' || k.type === 'urgent')!;
    sim.acceptContract(pid, c.id);
    expect(meta.profile.contracts.length).toBe(0);
  });
});

describe('supply contracts', () => {
  it('deliverSupply consumes goods and pays', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('supplier');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    // find a supply contract anywhere
    let supply = null as any;
    let stationId = '';
    for (const st of sim.system.stations) {
      supply = sim.boardFor(st.id).find((k) => k.type === 'supply');
      if (supply) {
        stationId = st.id;
        break;
      }
    }
    expect(supply).toBeTruthy();
    meta.profile.reputation = { helion: 50, meridian: 50, outwarden: 50, drift: 50, scrappers: 50 };
    e.dockedAt = stationId;
    sim.acceptContract(pid, supply.id);
    expect(meta.profile.contracts.length).toBe(1);
    sim.addCargo(meta.profile, supply.good, supply.qty);
    const creditsBefore = meta.profile.credits;
    sim.deliverSupply(pid, supply.id);
    expect(meta.profile.contracts.length).toBe(0);
    expect(meta.profile.credits).toBe(creditsBefore + supply.reward);
  });
});

describe('bounty contracts', () => {
  it('kills inside the zone count toward the bounty', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('hunter');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    let bounty = null as any;
    let stationId = '';
    for (const st of sim.system.stations) {
      bounty = sim.boardFor(st.id).find((k) => k.type === 'bounty');
      if (bounty) {
        stationId = st.id;
        break;
      }
    }
    expect(bounty).toBeTruthy();
    meta.profile.reputation = { helion: 50, meridian: 50, outwarden: 50, drift: 50, scrappers: 50 };
    e.dockedAt = stationId;
    sim.acceptContract(pid, bounty.id);
    const zone = sim.fieldById(bounty.pirateZone)!;
    sim.undock(pid);
    e.pos = { ...zone.pos };
    meta.profile.credits = 0;
    // kill the required pirates inside the zone
    for (let i = 0; i < bounty.killsRequired; i++) {
      const pirate = sim.spawnPirate('scout', { x: zone.pos.x + 500, y: zone.pos.y, z: zone.pos.z });
      sim.applyDamage(pirate, 99_999, pid, false);
    }
    expect(meta.profile.contracts.length).toBe(0);
    expect(meta.profile.credits).toBe(bounty.reward);
  });
});

describe('smuggling', () => {
  it('illegal cargo can be confiscated at legal stations', () => {
    // run several attempts: inspection is a 30% roll (vary the seed so the
    // deterministic rng draws differ between attempts)
    let confiscated = false;
    for (let attempt = 0; attempt < 30 && !confiscated; attempt++) {
      const sim = new Sim({ seed: 7741 + attempt });
      const pid = sim.addPlayer('smuggler');
      const meta = sim.meta(pid)!;
      const e = sim.entities.get(pid)!;
      sim.undock(pid);
      meta.undockInvuln = 0;
      meta.gearDown = true;
      meta.vtol = true;
      sim.addCargo(meta.profile, 'stims', 10);
      const st = sim.station('bren_yards')!;
      e.pos = padPoint(st);
      e.vel = v3();
      for (let i = 0; i < 20 * 6; i++) sim.tick();
      if (sim.freeQty(meta.profile, 'stims') === 0) confiscated = true;
    }
    expect(confiscated).toBe(true);
  });
});
