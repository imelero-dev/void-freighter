import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { vadd, vdist, v3 } from '../src/sim/vec';

function runTicks(sim: Sim, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...sim.tick());
  return events;
}

function deepSpacePlayer(sim: Sim) {
  const pid = sim.addPlayer('tester');
  sim.undock(pid);
  const e = sim.entities.get(pid)!;
  e.pos = v3(8e6, 2e6, 8e6);
  e.vel = v3();
  const meta = sim.meta(pid)!;
  meta.undockInvuln = 0;
  return { pid, e, meta };
}

function spawnMerchantNear(sim: Sim, pos: { x: number; y: number; z: number }) {
  const m = sim.spawnShipEntity();
  m.npc = 'merchant';
  m.factionId = 'drift';
  m.hullId = 'prospector';
  m.name = '"Test Trader"';
  m.maxHull = 260;
  m.hull = 260;
  m.maxShield = 220;
  m.shield = 220;
  m.pos = { ...pos };
  m.radius = 16;
  return m;
}

describe('ambient traffic spawning', () => {
  it('port space fills with civilian traffic while you loiter', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('watcher');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    sim.meta(pid)!.undockInvuln = 1e9;
    let sawTraffic = false;
    for (let i = 0; i < 20 * 120 && !sawTraffic; i++) {
      sim.tick();
      e.vel = v3();
      for (const x of sim.entities.values()) {
        if (x.npc) sawTraffic = true;
      }
    }
    expect(sawTraffic).toBe(true);
  });

  it('a capital ship (bulk carrier or gun platform) reliably appears', () => {
    const sim = new Sim();
    const { e, meta } = deepSpacePlayer(sim);
    meta.undockInvuln = 1e9;
    let sawCapital = false;
    for (let i = 0; i < 20 * 220 && !sawCapital; i++) {
      sim.tick();
      e.vel = v3();
      for (const x of sim.entities.values()) {
        if (x.npc === 'superfreighter' || x.pirate === 'corvette') sawCapital = true;
      }
    }
    expect(sawCapital).toBe(true);
  });

  it('traffic despawns once the player leaves the bubble', () => {
    const sim = new Sim();
    const { pid, e } = deepSpacePlayer(sim);
    const m = spawnMerchantNear(sim, vadd(e.pos, v3(3000, 0, 0)));
    runTicks(sim, 5);
    expect(sim.entities.get(m.id)).toBeTruthy();
    e.pos = v3(-2e7, 0, -2e7); // far across the system
    runTicks(sim, 5);
    expect(sim.entities.get(m.id)).toBeUndefined();
  });

  it('arriving haulers actually move stock (the economy breathes)', () => {
    const sim = new Sim();
    deepSpacePlayer(sim); // someone must be online for npcs to tick
    const dest = sim.system.stations.find((s) => s.id === 'cinder_forge')!;
    const before = sim.economy.stocks.get(dest.id)!.food;
    // a freighter two km out, inbound with food
    const h = sim.spawnShipEntity();
    h.npc = 'freighter';
    h.hullId = 'hauler';
    h.factionId = 'helion';
    h.name = '"Test Mule"';
    h.maxHull = 320;
    h.hull = 320;
    h.fieldId = dest.id;
    h.goodId = 'food';
    h.pos = vadd(dest.pos, v3(2800 + dest.radius, 0, 0));
    // park the player near so it doesn't bubble-despawn before arriving
    const p = sim.entities.get(sim.players.keys().next().value!)!;
    p.pos = vadd(dest.pos, v3(20_000, 0, 0));
    runTicks(sim, 20 * 4);
    expect(sim.entities.get(h.id)).toBeUndefined(); // docked and gone
    expect(sim.economy.stocks.get(dest.id)!.food).toBeGreaterThan(before);
  });
});

describe('police patrols', () => {
  it('a patrol engages and destroys a nearby pirate', () => {
    const sim = new Sim();
    const { e } = deepSpacePlayer(sim);
    // stage the fight near the player so nothing despawns
    const patrol = sim.spawnShipEntity();
    patrol.npc = 'patrol';
    patrol.hullId = 'interceptor';
    patrol.factionId = 'meridian';
    patrol.name = 'Test Patrol';
    patrol.maxHull = 220;
    patrol.hull = 220;
    patrol.maxShield = 200;
    patrol.shield = 200;
    patrol.pos = vadd(e.pos, v3(4000, 0, 0));
    patrol.spawnPos = { ...patrol.pos };
    const pirate = sim.spawnPirate('scout', vadd(e.pos, v3(5500, 0, 0)));
    let pirateDead = false;
    for (let i = 0; i < 20 * 90 && !pirateDead; i++) {
      sim.tick();
      e.vel = v3();
      if (!sim.entities.get(pirate.id)) pirateDead = true;
    }
    expect(pirateDead).toBe(true);
    expect(sim.entities.get(patrol.id)).toBeTruthy(); // and lived to tell
  });
});

describe('wandering merchants', () => {
  it('hail in range returns wares; buy and sell work', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    const m = spawnMerchantNear(sim, vadd(e.pos, v3(500, 0, 0)));
    meta.profile.credits = 50_000;

    const events: any[] = [];
    sim.traffic.hailMerchant(pid, m.id);
    events.push(...sim.tick());
    const offer = events.find((ev) => ev.type === 'merchant');
    expect(offer).toBeTruthy();
    expect(offer.wares.length).toBeGreaterThan(0);

    // buy the first ware
    const ware = offer.wares[0];
    const credits = meta.profile.credits;
    sim.traffic.merchantBuy(pid, m.id, ware.good, 1);
    expect(sim.freeQty(meta.profile, ware.good)).toBeGreaterThanOrEqual(1);
    expect(meta.profile.credits).toBe(credits - ware.price);

    // sell it back at 85% of base (a loss — merchants are not charities)
    sim.traffic.merchantSell(pid, m.id, ware.good, 1);
    expect(meta.profile.credits).toBeLessThan(credits);

    // out of range: hail refused
    e.pos = vadd(m.pos, v3(5000, 0, 0));
    const events2 = [];
    sim.traffic.hailMerchant(pid, m.id);
    events2.push(...sim.tick());
    expect(events2.find((ev) => ev.type === 'merchant')).toBeUndefined();
  });
});

describe('distress rescues', () => {
  it('saving a civilian from pirates pays a reward and rep', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    sim.traffic.spawnDistress(e, pid);
    const civ = [...sim.entities.values()].find((x) => x.npc && !x.pirate);
    const pirates = [...sim.entities.values()].filter((x) => x.pirate);
    expect(civ).toBeTruthy();
    expect(pirates.length).toBeGreaterThan(0);
    const credits = meta.profile.credits;
    for (const p of pirates) {
      sim.applyDamage(p, 99_999, pid, false);
    }
    runTicks(sim, 3);
    expect(meta.profile.credits).toBeGreaterThan(credits);
  });

  it('killing civilians costs reputation', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    const civ = spawnMerchantNear(sim, vadd(e.pos, v3(600, 0, 0)));
    civ.factionId = 'meridian';
    sim.applyDamage(civ, 99_999, pid, false);
    expect(sim.entities.get(civ.id)).toBeUndefined();
    expect(meta.profile.reputation.meridian).toBeLessThan(0);
  });
});
