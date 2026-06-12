import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { DT } from '../src/sim/types';
import { qLookAt, vdist, vlen, vnorm, vsub, v3 } from '../src/sim/vec';

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
