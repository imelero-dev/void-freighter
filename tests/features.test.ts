import { describe, expect, it } from 'vitest';
import { blankEntity, Sim } from '../src/sim/sim';
import { vadd, vdist, vscale, v3 } from '../src/sim/vec';
import { terrainHeight } from '../src/sim/terrain';
import { TURBO_SPEED } from '../src/sim/data';

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

describe('turbo overburn', () => {
  it('pinned throttle in empty space sails past the speed cap toward the turbo ceiling', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    meta.input.thrustForward = 1;
    meta.input.turbo = true;
    runTicks(sim, 20 * 25);
    const speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
    expect(speed).toBeGreaterThan(meta.stats.maxSpeed * 1.5);
    expect(speed).toBeLessThanOrEqual(TURBO_SPEED + 1);
    // free overburn: the gauge stays charged with nobody around
    expect(meta.turboCharge).toBeGreaterThan(0.9);
  });

  it('with hostiles nearby it is a burst limited by the gauge', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    sim.spawnPirate('fighter', vadd(e.pos, v3(2000, 0, 0)));
    meta.input.thrustForward = 1;
    meta.input.turbo = true;
    runTicks(sim, 20 * 5); // 5 s > 3.5 s gauge
    expect(meta.turboCharge).toBe(0);
    expect(meta.turboActive).toBe(false); // drained
    // letting go recharges
    meta.input.turbo = false;
    runTicks(sim, 20 * 10);
    expect(meta.turboCharge).toBeGreaterThan(0.9);
  });
});

describe('encounter pacing', () => {
  it('loitering in a dangerous field draws pirates within a few minutes', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('bait');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const field = sim.system.belts.find((b) => b.danger > 0.5)!.fields[0];
    e.pos = { ...field.pos };
    e.vel = v3();
    sim.meta(pid)!.undockInvuln = 1e9; // observe without dying
    let sawPirate = false;
    for (let i = 0; i < 20 * 240 && !sawPirate; i++) {
      sim.tick();
      e.vel = v3();
      for (const x of sim.entities.values()) {
        if (x.kind === 'ship' && x.pirate) sawPirate = true;
      }
    }
    expect(sawPirate).toBe(true);
  });

  it('drifting in deep space eventually surfaces a wreck or derelict', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('drifter');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    e.pos = v3(8e6, 2e6, -8e6); // far from everything
    e.vel = v3();
    sim.meta(pid)!.undockInvuln = 1e9;
    let found = false;
    for (let i = 0; i < 20 * 420 && !found; i++) {
      sim.tick();
      for (const x of sim.entities.values()) {
        if (x.derelict || x.kind === 'loot') found = true;
      }
    }
    expect(found).toBe(true);
  });
});

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

describe('hull patch kits', () => {
  it('repairs 30% in the field, but never under fire', () => {
    const sim = new Sim();
    const { pid, e, meta } = deepSpacePlayer(sim);
    sim.addCargo(meta.profile, 'repair_kit', 2);
    e.hull = Math.round(e.maxHull * 0.4);

    // under fire: locked out
    const pirate = sim.spawnPirate('fighter', vadd(e.pos, v3(900, 0, 0)), pid);
    sim.applyDamage(e, 1, pirate.id, false);
    sim.useRepairKit(pid);
    expect(sim.freeQty(meta.profile, 'repair_kit')).toBe(2); // not consumed
    expect(e.hull).toBeLessThan(e.maxHull * 0.5);

    // clear the area and wait out the lockout
    sim.entities.delete(pirate.id);
    runTicks(sim, 20 * 11);
    const before = e.hull;
    sim.useRepairKit(pid);
    expect(sim.freeQty(meta.profile, 'repair_kit')).toBe(1);
    expect(e.hull).toBeGreaterThan(before);
  });

  it('refuses while docked and when hull is full', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('safe');
    const meta = sim.meta(pid)!;
    sim.addCargo(meta.profile, 'repair_kit', 1);
    sim.useRepairKit(pid); // docked
    expect(sim.freeQty(meta.profile, 'repair_kit')).toBe(1);
    sim.undock(pid);
    sim.useRepairKit(pid); // full hull
    expect(sim.freeQty(meta.profile, 'repair_kit')).toBe(1);
  });
});

describe('workshop crafting', () => {
  it('rent a bay, craft a module from materials into the stash', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('crafter');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    e.dockedAt = 'bren_yards'; // shipyard station
    meta.profile.credits = 10_000;

    // no rental yet: craft refused (quantities sized to fit the starter hold)
    sim.addCargo(meta.profile, 'steel', 20);
    sim.addCargo(meta.profile, 'alloy', 10);
    sim.addCargo(meta.profile, 'machinery', 2);
    sim.craftModule(pid, 'engine', 1);
    expect(meta.profile.moduleStash.length).toBe(0);

    sim.rentWorkshop(pid);
    expect(meta.profile.credits).toBe(10_000 - 2500);
    expect(sim.workshopActive(meta.profile, 'bren_yards')).toBe(true);

    sim.craftModule(pid, 'engine', 1);
    expect(meta.profile.moduleStash).toEqual([{ slot: 'engine', tier: 1 }]);

    // missing materials for a high tier
    sim.craftModule(pid, 'engine', 5);
    expect(meta.profile.moduleStash.length).toBe(1);

    // repair kit fabrication
    sim.addCargo(meta.profile, 'components', 2);
    sim.craftRepairKit(pid);
    expect(sim.freeQty(meta.profile, 'repair_kit')).toBe(1);
  });

  it('rental expires with world time', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('renter');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    e.dockedAt = 'bren_yards';
    meta.profile.credits = 5000;
    sim.rentWorkshop(pid);
    expect(sim.workshopActive(meta.profile, 'bren_yards')).toBe(true);
    sim.time += 24 * 3600 + 1;
    expect(sim.workshopActive(meta.profile, 'bren_yards')).toBe(false);
  });
});

describe('warehouse storage', () => {
  it('lease plots, deposit and withdraw with volume limits', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('hoarder');
    const meta = sim.meta(pid)!;
    meta.profile.credits = 20_000;
    // docked at morrow by default
    sim.buyWarehousePlot(pid);
    const wh = meta.profile.warehouses['morrow_granary'];
    expect(wh.capacity).toBe(250);
    expect(meta.profile.credits).toBe(20_000 - 3500);

    sim.addCargo(meta.profile, 'steel', 20); // 16 m³
    sim.warehouseDeposit(pid, 'steel', 20);
    expect(sim.freeQty(meta.profile, 'steel')).toBe(0);
    expect(wh.items).toEqual([{ good: 'steel', qty: 20 }]);

    sim.warehouseWithdraw(pid, 'steel', 5);
    expect(sim.freeQty(meta.profile, 'steel')).toBe(5);
    expect(wh.items[0].qty).toBe(15);

    // capacity is enforced
    sim.addCargo(meta.profile, 'machinery', 10); // 18 m³ each... 1.8 each = 18 m³
    wh.capacity = 20; // shrink to force the rejection
    sim.warehouseDeposit(pid, 'machinery', 10);
    expect(sim.freeQty(meta.profile, 'machinery')).toBe(10); // refused

    // second plot costs more
    wh.capacity = 250;
    sim.buyWarehousePlot(pid);
    expect(wh.capacity).toBe(500);
    expect(meta.profile.credits).toBe(20_000 - 3500 - 5250);
  });

  it('sealed contract cargo cannot be stored', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('sneak');
    const meta = sim.meta(pid)!;
    meta.profile.credits = 10_000;
    sim.buyWarehousePlot(pid);
    sim.addCargo(meta.profile, 'food', 5, 'contract_x');
    sim.warehouseDeposit(pid, 'food', 5);
    expect(meta.profile.warehouses['morrow_granary'].items.length).toBe(0);
  });
});

describe('station info intel', () => {
  it('unlocks an unvisited station for credits scaled by distance', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('scout');
    const meta = sim.meta(pid)!;
    meta.profile.credits = 50_000;
    const unknown = sim.system.stations.find((s) => !meta.profile.knownStations.includes(s.id))!;
    sim.buyStationInfo(pid, unknown.id);
    expect(meta.profile.knownStations).toContain(unknown.id);
    expect(meta.profile.credits).toBeLessThan(50_000);
    const paid = 50_000 - meta.profile.credits;
    expect(paid).toBeGreaterThanOrEqual(500);
    // buying twice is a no-op
    sim.buyStationInfo(pid, unknown.id);
    expect(meta.profile.credits).toBe(50_000 - paid);
  });

  it('rejects when broke', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('broke');
    const meta = sim.meta(pid)!;
    meta.profile.credits = 10;
    const unknown = sim.system.stations.find((s) => !meta.profile.knownStations.includes(s.id))!;
    sim.buyStationInfo(pid, unknown.id);
    expect(meta.profile.knownStations).not.toContain(unknown.id);
    expect(meta.profile.credits).toBe(10);
  });
});

describe('planetary landing', () => {
  it('lets a ship descend to the surface instead of bouncing off a field', () => {
    const sim = new Sim();
    const { pid, e } = deepSpacePlayer(sim);
    const meta = sim.meta(pid)!;
    meta.flightAssist = false;
    meta.gearDown = true;
    // a non-lava world (lava cooks the hull on the way down — by design)
    const planet = sim.system.planets.find((p) => p.kind !== 'lava')!;
    // the ground is a heightfield now, so find how tall the terrain is right
    // beneath the descent and start just above it
    const up = v3(0, 1, 0);
    const body = { pos: planet.pos, radius: planet.radius, kind: planet.kind, colorSeed: planet.colorSeed };
    const groundH = terrainHeight(body, vadd(planet.pos, vscale(up, planet.radius + 5000)));
    e.pos = vadd(planet.pos, vscale(up, planet.radius + groundH + e.radius + 40));
    e.vel = vscale(up, -25);
    const events = runTicks(sim, 50);
    // no exclusion field, and the ship comes to rest ON the terrain (no clip)
    expect(events.some((ev) => ev.type === 'forcefield')).toBe(false);
    const alt = vdist(e.pos, planet.pos) - planet.radius;
    expect(alt).toBeGreaterThan(groundH - 5);            // didn't clip through the ground
    expect(alt).toBeLessThan(groundH + e.radius + 30);   // settled on the terrain, not floating
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
