import { describe, expect, it } from 'vitest';
import { blankEntity, Sim } from '../src/sim/sim';
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

describe('cannon ammo', () => {
  it('firing consumes rounds and stops when dry; rearm refills for credits', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    const before = e.cannonAmmo;
    expect(before).toBeGreaterThan(0);
    sim.setFiring(pid, true);
    runTicks(sim, 40); // ~2 s of fire
    expect(e.cannonAmmo).toBeLessThan(before);

    // drain the magazine: no more bolts spawn
    e.cannonAmmo = 0;
    runTicks(sim, 20);
    const boltsWhileDry = [...sim.entities.values()].filter((x) => x.kind === 'bolt' && x.ownerId === pid);
    runTicks(sim, 30);
    const boltsAfter = [...sim.entities.values()].filter((x) => x.kind === 'bolt' && x.ownerId === pid);
    expect(boltsAfter.length).toBeLessThanOrEqual(boltsWhileDry.length);

    // rearm while docked
    sim.setFiring(pid, false);
    e.dockedAt = 'morrow_granary';
    const credits = meta.profile.credits;
    sim.restockCannonAmmo(pid);
    expect(e.cannonAmmo).toBe(meta.stats.cannonAmmoMax);
    expect(meta.profile.credits).toBeLessThan(credits);
  });
});

describe('ironclad corvette', () => {
  it('spawns with four turrets that die with the carrier', () => {
    const sim = new Sim();
    const { e } = deepSpacePlayer(sim);
    const corvette = sim.spawnCorvette(vadd(e.pos, v3(2000, 0, 0)));
    const turrets = [...sim.entities.values()].filter((x) => x.parentId === corvette.id);
    expect(turrets.length).toBe(4);
    runTicks(sim, 20);
    // turrets ride the hull
    for (const t of turrets) {
      expect(vdist(t.pos, corvette.pos)).toBeLessThan(80);
    }
    // killing the carrier removes the turrets
    sim.applyDamage(corvette, 99_999, -1, true);
    expect(sim.entities.get(corvette.id)).toBeUndefined();
    for (const t of turrets) {
      expect(sim.entities.get(t.id)).toBeUndefined();
    }
  });

  it('turrets are individually destructible and shoot at the aggro target', () => {
    const sim = new Sim();
    const { pid, e } = deepSpacePlayer(sim);
    e.hull = 5000;
    e.maxHull = 5000;
    e.shield = 0;
    const corvette = sim.spawnCorvette(vadd(e.pos, v3(700, 0, 0)), pid);
    const turrets = [...sim.entities.values()].filter((x) => x.parentId === corvette.id);
    const events = runTicks(sim, 20 * 4);
    // turret bolts exist (someone is shooting)
    expect(events.some((ev) => ev.type === 'shot')).toBe(true);
    // a turret can be destroyed without harming the carrier
    sim.applyDamage(turrets[0], 99_999, pid, false);
    expect(sim.entities.get(turrets[0].id)).toBeUndefined();
    expect(sim.entities.get(corvette.id)).toBeTruthy();
  });
});

describe('planetary exclusion field', () => {
  it('bounces ships off and raises a warning event', () => {
    const sim = new Sim();
    const { pid, e } = deepSpacePlayer(sim);
    const planet = sim.system.planets[0];
    // drop the ship just inside the shell, flying inward
    const shell = planet.radius * 1.15;
    e.pos = vadd(planet.pos, v3(shell - 2000, 0, 0));
    e.vel = v3(-300, 0, 0);
    const events = runTicks(sim, 10);
    expect(events.some((ev) => ev.type === 'forcefield' && ev.pid === pid)).toBe(true);
    expect(vdist(e.pos, planet.pos)).toBeGreaterThanOrEqual(shell);
    expect(e.hull).toBe(e.maxHull); // the wall shoves, it doesn't wreck you
  });
});

describe('derelict encounters', () => {
  function spawnDerelictNear(sim: Sim, pos: { x: number; y: number; z: number }) {
    // force the wreck spawner deterministically by injecting a hulk directly
    const hulk = blankEntity(99_000, 'ship');
    hulk.derelict = true;
    hulk.name = 'Derelict — "Test Hulk"';
    hulk.hullId = 'hauler';
    hulk.radius = 16;
    hulk.maxHull = 400;
    hulk.hull = 400;
    hulk.pos = { ...pos };
    hulk.ttl = 1200;
    sim.entities.set(hulk.id, hulk);
    return hulk;
  }

  it('prompts with a story when you fly close', () => {
    const sim = new Sim();
    const { pid, e } = deepSpacePlayer(sim);
    const hulk = spawnDerelictNear(sim, vadd(e.pos, v3(300, 0, 0)));
    const events = runTicks(sim, 30);
    const prompt = events.find((ev) => ev.type === 'derelict');
    expect(prompt).toBeTruthy();
    expect((prompt as any).entityId).toBe(hulk.id);
    expect((prompt as any).story.length).toBeGreaterThan(20);
    // only prompts once
    const again = runTicks(sim, 30).find((ev) => ev.type === 'derelict');
    expect(again).toBeUndefined();
  });

  it('breaching gives a salvage destination or hurts you', () => {
    let sawCache = false;
    let sawDamage = false;
    for (let attempt = 0; attempt < 24 && !(sawCache && sawDamage); attempt++) {
      const sim = new Sim({ seed: 7741 + attempt });
      const { pid, e, meta } = deepSpacePlayer(sim);
      const hulk = spawnDerelictNear(sim, vadd(e.pos, v3(300, 0, 0)));
      sim.openDerelict(pid, hulk.id);
      expect(hulk.derelictOpened).toBe(true);
      if (meta.destination?.name === 'Salvage Cache') {
        sawCache = true;
        const caches = [...sim.entities.values()].filter((x) => x.kind === 'loot');
        expect(caches.length).toBeGreaterThanOrEqual(4);
      }
      if (e.hull < e.maxHull) sawDamage = true;
      // a second breach does nothing
      const hull = e.hull;
      sim.openDerelict(pid, hulk.id);
      expect(e.hull).toBe(hull);
    }
    expect(sawCache).toBe(true);
    expect(sawDamage).toBe(true);
  });

  it('derelicts soak weapon fire without dying', () => {
    const sim = new Sim();
    const { pid, e } = deepSpacePlayer(sim);
    const hulk = spawnDerelictNear(sim, vadd(e.pos, v3(300, 0, 0)));
    sim.applyDamage(hulk, 99_999, pid, false);
    expect(sim.entities.get(hulk.id)).toBeTruthy();
    expect(hulk.hull).toBe(hulk.maxHull);
  });
});
