import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { DT, emptyShipInput } from '../src/sim/types';
import { integrateFlight } from '../src/sim/flight';
import { qLookAt, vadd, vdist, vlen, vnorm, vscale, vsub, v3 } from '../src/sim/vec';

function makeSim(): Sim {
  return new Sim();
}

function runTicks(sim: Sim, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...sim.tick());
  return events;
}

describe('system generation', () => {
  it('is deterministic from the seed', () => {
    const a = new Sim().system;
    const b = new Sim().system;
    expect(a.stations.map((s) => s.id)).toEqual(b.stations.map((s) => s.id));
    for (let i = 0; i < a.stations.length; i++) {
      expect(a.stations[i].pos).toEqual(b.stations[i].pos);
    }
    expect(a.planets.length).toBeGreaterThanOrEqual(5);
    expect(a.belts.length).toBeGreaterThanOrEqual(3);
    expect(a.stations.length).toBeGreaterThanOrEqual(7);
  });

  it('every planet station id resolves and black market exists', () => {
    const sys = new Sim().system;
    for (const p of sys.planets) {
      if (p.stationId) expect(sys.stations.some((s) => s.id === p.stationId)).toBe(true);
    }
    expect(sys.stations.some((s) => s.blackMarket)).toBe(true);
  });
});

describe('flight physics', () => {
  it('thrust accelerates the ship and flight assist caps speed', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.input.thrustForward = 1;
    runTicks(sim, 20 * 30); // 30 s
    const speed = vlen(e.vel);
    expect(speed).toBeGreaterThan(50);
    expect(speed).toBeLessThanOrEqual(meta.stats.maxSpeed * 1.01);
  });

  it('is deterministic: same inputs produce same trajectory', () => {
    const run = () => {
      const sim = makeSim();
      const pid = sim.addPlayer('tester');
      sim.undock(pid);
      const meta = sim.meta(pid)!;
      meta.input.thrustForward = 1;
      meta.input.yaw = 0.3;
      runTicks(sim, 200);
      const e = sim.entities.get(pid)!;
      return { ...e.pos };
    };
    expect(run()).toEqual(run());
  });

  it('brake decays velocity', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.input.thrustForward = 1;
    runTicks(sim, 100);
    meta.input.thrustForward = 0;
    meta.input.brake = true;
    runTicks(sim, 20 * 20);
    expect(vlen(e.vel)).toBeLessThan(5);
  });
});

// Simulator flight model acceptance (#15): inertia, decoupled velocity/
// orientation, Flight Assist on vs off. Exercises the shared integrator
// directly so the behaviour is pinned independent of sim plumbing.
describe('flight model: inertia & flight assist', () => {
  const body = () => ({
    pos: v3(), vel: v3(), orient: { x: 0, y: 0, z: 0, w: 1 }, angVel: v3(), throttle: 0,
  });
  const perf = (massFactor = 1) => ({ maxSpeed: 200, accel: 30, turnRate: 2, massFactor });

  it('FA off: rotation persists after the stick is released (angular momentum)', () => {
    const b = body();
    const i = emptyShipInput(); i.yaw = 1;
    for (let k = 0; k < 10; k++) integrateFlight(b, i, perf(), DT, false);
    const spin = b.angVel.y;
    expect(Math.abs(spin)).toBeGreaterThan(0.1);
    const idle = emptyShipInput();
    for (let k = 0; k < 60; k++) integrateFlight(b, idle, perf(), DT, false);
    expect(b.angVel.y).toBeCloseTo(spin, 6); // nothing damps it
  });

  it('FA on: rotation bleeds back to zero after release', () => {
    const b = body();
    const i = emptyShipInput(); i.yaw = 1;
    for (let k = 0; k < 10; k++) integrateFlight(b, i, perf(), DT, true);
    expect(Math.abs(b.angVel.y)).toBeGreaterThan(0.1);
    const idle = emptyShipInput();
    for (let k = 0; k < 40; k++) integrateFlight(b, idle, perf(), DT, true);
    expect(Math.abs(b.angVel.y)).toBeLessThan(0.05);
  });

  it('FA off: velocity drifts indefinitely with no input (pure Newtonian)', () => {
    const b = body();
    const i = emptyShipInput(); i.thrustForward = 1;
    for (let k = 0; k < 20; k++) integrateFlight(b, i, perf(), DT, false);
    const v = vlen(b.vel);
    expect(v).toBeGreaterThan(10);
    const idle = emptyShipInput();
    for (let k = 0; k < 120; k++) integrateFlight(b, idle, perf(), DT, false);
    expect(vlen(b.vel)).toBeCloseTo(v, 6); // coasts on, never self-corrects
  });

  it('heavy hulls resist direction changes more than light ones (mass is felt)', () => {
    const light = body(), heavy = body();
    const i = emptyShipInput(); i.pitch = 1;
    for (let k = 0; k < 3; k++) {
      integrateFlight(light, i, perf(1), DT, true);
      integrateFlight(heavy, i, perf(2.5), DT, true);
    }
    expect(Math.abs(heavy.angVel.x)).toBeLessThan(Math.abs(light.angVel.x));
  });
});

describe('VTOL flight mode (#19)', () => {
  it('VTOL caps the forward speed envelope for precise hover', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    sim.toggleVtol(pid);
    expect(meta.vtol).toBe(true);
    meta.input.thrustForward = 1;
    runTicks(sim, 20 * 30);
    expect(vlen(e.vel)).toBeLessThanOrEqual(meta.stats.maxSpeed * 0.25);
  });

  it('engaging the cruise drive exits VTOL (mutually exclusive)', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const meta = sim.meta(pid)!;
    sim.toggleVtol(pid);
    expect(meta.vtol).toBe(true);
    sim.toggleCruise(pid);
    expect(meta.vtol).toBe(false);
  });
});

describe('solid collision (#21)', () => {
  const stageAtStation = (sim: Sim, speed: number) => {
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.undockInvuln = 0;
    meta.flightAssist = false; // coast straight in, deterministic
    const st = sim.system.stations[0];
    const dir = v3(1, 0, 0);
    e.pos = vadd(st.pos, vscale(dir, st.radius + e.radius + 5));
    e.vel = vscale(dir, -speed); // straight into the hull
    return { e, st };
  };

  it('low-speed contact gently stops/slides — no hard bounce, no clipping', () => {
    const sim = makeSim();
    const { e, st } = stageAtStation(sim, 20);
    runTicks(sim, 40);
    expect(vdist(e.pos, st.pos)).toBeGreaterThanOrEqual(st.radius + e.radius - 1); // never inside
    expect(vlen(e.vel)).toBeLessThan(20); // not flung away
  });

  it('high-speed impact damages the hull proportionally and still resolves cleanly', () => {
    const sim = makeSim();
    const { e, st } = stageAtStation(sim, 400);
    const hull0 = e.hull;
    runTicks(sim, 5);
    expect(e.hull).toBeLessThan(hull0);
    expect(vdist(e.pos, st.pos)).toBeGreaterThanOrEqual(st.radius + e.radius - 1);
  });

  it('a heavier hull takes more impact damage than a light one at equal speed', () => {
    const dmg = (massFactor: number) => {
      const sim = makeSim();
      const pid = sim.addPlayer('tester');
      sim.undock(pid);
      const e = sim.entities.get(pid)!;
      const meta = sim.meta(pid)!;
      meta.undockInvuln = 0;
      meta.flightAssist = false;
      meta.stats.massFactor = massFactor; // isolate mass as the only variable
      e.maxHull = e.hull = 100_000; // big tank so neither hull dies + resets
      const st = sim.system.stations[0];
      const dir = v3(1, 0, 0);
      e.pos = vadd(st.pos, vscale(dir, st.radius + e.radius + 5));
      e.vel = vscale(dir, -300);
      const h0 = e.hull;
      runTicks(sim, 5);
      return h0 - e.hull;
    };
    expect(dmg(2.5)).toBeGreaterThan(dmg(0.8));
  });
});

describe('docking', () => {
  it('docks when close and slow, undocks cleanly', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    const e = sim.entities.get(pid)!;
    expect(e.dockedAt).toBe('morrow_granary'); // starts docked
    sim.undock(pid);
    expect(e.dockedAt).toBeNull();
    // come back
    const st = sim.station('morrow_granary')!;
    e.pos = { x: st.pos.x + 1500, y: st.pos.y, z: st.pos.z };
    e.vel = v3();
    sim.requestDock(pid);
    runTicks(sim, 20 * 5);
    expect(e.dockedAt).toBe('morrow_granary');
  });

  it('refuses docking when too fast or too far', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const st = sim.station('morrow_granary')!;
    e.pos = { x: st.pos.x + 1500, y: st.pos.y, z: st.pos.z };
    e.vel = v3(200, 0, 0);
    sim.requestDock(pid);
    runTicks(sim, 20);
    expect(e.dockedAt).toBeNull();
    e.vel = v3();
    e.pos = { x: st.pos.x + 50_000, y: st.pos.y, z: st.pos.z };
    sim.requestDock(pid);
    runTicks(sim, 20);
    expect(e.dockedAt).toBeNull();
  });
});

describe('cruise drive', () => {
  it('charges, ramps speed and burns fuel', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    // get clear of the station mass lock
    e.pos = { x: e.pos.x + 80_000, y: e.pos.y + 50_000, z: e.pos.z + 80_000 };
    const fuelBefore = meta.profile.fuel;
    sim.toggleCruise(pid);
    expect(e.cruise).toBe('charging');
    runTicks(sim, 20 * 4);
    expect(e.cruise).toBe('cruise');
    runTicks(sim, 20 * 10);
    expect(e.cruiseSpeed).toBeGreaterThan(2000);
    expect(meta.profile.fuel).toBeLessThan(fuelBefore);
  });

  it('drops out near a destination', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    e.pos = { x: e.pos.x + 80_000, y: e.pos.y + 50_000, z: e.pos.z + 80_000 };
    meta.interdictCooldown = 1e9; // no pirate ambushes in this test
    const target = { x: e.pos.x + 3e6, y: e.pos.y, z: e.pos.z };
    sim.setDestination(pid, { kind: 'point', id: '', name: 'Test Point', pos: target });
    e.orient = qLookAt(vnorm(vsub(target, e.pos)));
    sim.toggleCruise(pid);
    runTicks(sim, 20 * 120);
    expect(e.cruise).toBe('off');
    expect(vdist(e.pos, target)).toBeLessThan(60_000);
  });

  it('out of fuel kills the cruise and rescue tow saves you', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    e.pos = { x: e.pos.x + 200_000, y: e.pos.y + 100_000, z: e.pos.z };
    meta.profile.fuel = 4;
    sim.toggleCruise(pid);
    runTicks(sim, 20 * 30);
    expect(e.cruise).toBe('off');
    expect(meta.profile.fuel).toBeLessThanOrEqual(4);
    meta.profile.fuel = 0;
    const creditsBefore = meta.profile.credits;
    sim.hailRescue(pid);
    runTicks(sim, 20 * 10);
    expect(e.dockedAt).not.toBeNull();
    expect(meta.profile.credits).toBeLessThan(creditsBefore);
    expect(meta.profile.fuel).toBeGreaterThan(0);
  });
});

describe('persistence round-trip', () => {
  it('serializes and restores a profile', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    const meta = sim.meta(pid)!;
    meta.profile.credits = 12345;
    sim.addCargo(meta.profile, 'steel', 7);
    const prof = sim.serializeProfile(pid)!;
    const json = JSON.parse(JSON.stringify(prof));

    const sim2 = makeSim();
    const pid2 = sim2.addPlayer('tester', json);
    const meta2 = sim2.meta(pid2)!;
    expect(meta2.profile.credits).toBe(12345);
    expect(sim2.freeQty(meta2.profile, 'steel')).toBe(7);
    expect(sim2.entities.get(pid2)!.dockedAt).toBe('morrow_granary');
  });
});
