import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { qLookAt, vadd, vnorm, vsub, v3 } from '../src/sim/vec';

function runTicks(sim: Sim, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...sim.tick());
  return events;
}

// place the player in deep space, far from any station/planet
function deepSpacePlayer(sim: Sim) {
  const pid = sim.addPlayer('fighter');
  sim.undock(pid);
  const e = sim.entities.get(pid)!;
  e.pos = v3(8e6, 2e6, 8e6);
  e.vel = v3();
  const meta = sim.meta(pid)!;
  meta.undockInvuln = 0;
  return { pid, e, meta };
}

describe('damage model', () => {
  it('applies to shield first, then hull', () => {
    const sim = new Sim();
    const { e } = deepSpacePlayer(sim);
    const shieldBefore = e.shield;
    sim.applyDamage(e, 20, -1, true);
    expect(e.shield).toBe(shieldBefore - 20);
    expect(e.hull).toBe(e.maxHull);
    sim.applyDamage(e, e.shield + 10, -1, true);
    expect(e.shield).toBe(0);
    expect(e.hull).toBeLessThan(e.maxHull);
  });

  it('shield regenerates after a quiet delay', () => {
    const sim = new Sim();
    const { e } = deepSpacePlayer(sim);
    sim.applyDamage(e, 30, -1, true);
    const damaged = e.shield;
    runTicks(sim, 20 * 3); // within regen delay
    expect(e.shield).toBeLessThanOrEqual(damaged + 0.01);
    runTicks(sim, 20 * 10);
    expect(e.shield).toBeGreaterThan(damaged);
  });

  it('docked ships are invulnerable', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('safe');
    const e = sim.entities.get(pid)!;
    expect(e.dockedAt).not.toBeNull();
    sim.applyDamage(e, 9999, -1, true);
    expect(e.hull).toBe(e.maxHull);
  });
});

describe('pirates & loot', () => {
  it('player can destroy a pirate, which drops collectable loot', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    const pirate = sim.spawnPirate('scout', vadd(e.pos, v3(400, 0, 0)));
    // aim and unload
    e.orient = qLookAt(vnorm(vsub(pirate.pos, e.pos)));
    sim.setTarget(pid, pirate.id);
    sim.setFiring(pid, true);
    // pirate will fight back; give the player an edge
    e.hull = 500;
    e.maxHull = 500;
    let dead = false;
    for (let i = 0; i < 20 * 30 && !dead; i++) {
      // keep tracking the pirate
      const p = sim.entities.get(pirate.id);
      if (!p) {
        dead = true;
        break;
      }
      e.orient = qLookAt(vnorm(vsub(p.pos, e.pos)));
      e.pos = vadd(p.pos, vscaleTest(vnorm(vsub(e.pos, p.pos)), 350));
      sim.tick();
    }
    expect(dead).toBe(true);
    expect(meta.profile.stats.kills).toBe(1);
    // a loot container should exist
    const loot = [...sim.entities.values()].find((x) => x.kind === 'loot');
    expect(loot).toBeTruthy();
    // collect it
    const creditsBefore = meta.profile.credits;
    e.pos = { ...loot!.pos };
    runTicks(sim, 10);
    expect(meta.profile.credits).toBeGreaterThanOrEqual(creditsBefore);
    expect(sim.entities.get(loot!.id)).toBeUndefined();
  });

  it('pirate AI engages a nearby player', () => {
    const sim = new Sim();
    const { e } = deepSpacePlayer(sim);
    const pirate = sim.spawnPirate('fighter', vadd(e.pos, v3(3000, 0, 0)));
    runTicks(sim, 20 * 5);
    expect(['approach', 'attack']).toContain(pirate.aiState);
    expect(pirate.aggroId).not.toBeNull();
  });

  it('station turrets shred pirates in the police zone', () => {
    const sim = new Sim();
    const st = sim.station('morrow_granary')!;
    const pirate = sim.spawnPirate('scout', vadd(st.pos, v3(3000, 0, 0)));
    runTicks(sim, 20 * 8);
    // dead or fleeing with damage
    const p = sim.entities.get(pirate.id);
    expect(!p || p.hull < p.maxHull || p.aiState === 'flee').toBe(true);
  });
});

describe('player death', () => {
  it('loses cargo, pays insurance, respawns docked', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    sim.addCargo(meta.profile, 'steel', 10);
    meta.profile.credits = 10_000;
    const pirate = sim.spawnPirate('elite', vadd(e.pos, v3(500, 0, 0)));
    sim.applyDamage(e, 99_999, pirate.id, false);
    expect(meta.profile.cargo.length).toBe(0);
    expect(meta.profile.credits).toBeLessThan(10_000);
    expect(e.dockedAt).toBe('morrow_granary'); // respawn station
    expect(e.hull).toBe(e.maxHull);
    expect(meta.profile.stats.deaths).toBe(1);
  });

  it('death fails transport contracts whose cargo was aboard', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('courier');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    meta.profile.reputation = { helion: 50, meridian: 50, outwarden: 50, drift: 50, scrappers: 50 };
    // accept a transport contract from the starting station board
    const board = sim.boardFor('morrow_granary');
    const transport = board.find((c) => (c.type === 'transport' || c.type === 'urgent') && c.qty <= 16);
    expect(transport).toBeTruthy();
    sim.acceptContract(pid, transport!.id);
    expect(meta.profile.contracts.length).toBe(1);
    // die in deep space
    sim.undock(pid);
    e.pos = v3(8e6, 2e6, 8e6);
    meta.undockInvuln = 0;
    sim.applyDamage(e, 99_999, -1, true);
    expect(meta.profile.contracts.length).toBe(0);
  });
});

describe('missiles', () => {
  it('locks on and a fired missile damages the target', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    meta.profile.modules.missile = 1;
    sim.recomputeStats(pid);
    e.missileAmmo = 4;
    const pirate = sim.spawnPirate('raider', vadd(e.pos, v3(1500, 0, 0)));
    sim.setTarget(pid, pirate.id);
    e.orient = qLookAt(vnorm(vsub(pirate.pos, e.pos)));
    // hold the lock
    for (let i = 0; i < 20 * 6 && !e.lockedOn; i++) {
      const p = sim.entities.get(pirate.id)!;
      e.orient = qLookAt(vnorm(vsub(p.pos, e.pos)));
      e.pos = vadd(p.pos, vscaleTest(vnorm(vsub(e.pos, p.pos)), 1500));
      e.vel = v3();
      sim.tick();
    }
    expect(e.lockedOn).toBe(true);
    const hullBefore = pirate.hull + pirate.shield;
    sim.fireMissile(pid);
    expect(e.missileAmmo).toBe(3);
    for (let i = 0; i < 20 * 10; i++) {
      const p = sim.entities.get(pirate.id);
      if (!p) break;
      e.pos = vadd(p.pos, vscaleTest(vnorm(vsub(e.pos, p.pos)), 1500));
      e.vel = v3();
      sim.tick();
    }
    const p = sim.entities.get(pirate.id);
    expect(!p || p.hull + p.shield < hullBefore).toBe(true);
  });
});

function vscaleTest(a: { x: number; y: number; z: number }, s: number) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
