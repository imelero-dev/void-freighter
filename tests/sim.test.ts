import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { DT, emptyShipInput } from '../src/sim/types';
import { integrateFlight } from '../src/sim/flight';
import { isLandable } from '../src/sim/system';
import { hangarFrame, padPoint } from '../src/sim/docking';
import { qLookAt, vadd, vdist, vdot, vlen, vnorm, vscale, vsub, v3 } from '../src/sim/vec';

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
  it('VTOL is true vertical flight: thrust-up climbs along local up, nose-independent', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    // hang in a planet's air column with the nose pointed horizontally — far
    // from any station so "up" is the planet's radial
    const p = sim.system.planets.find((pp) => isLandable(pp.kind))!;
    const up = vnorm(vsub(e.pos, p.pos));
    e.pos = vadd(p.pos, vscale(up, p.radius + 30_000));
    e.orient = qLookAt(vnorm(v3(up.z, 0, -up.x))); // a horizontal heading
    e.vel = v3();
    sim.toggleVtol(pid);
    expect(meta.vtol).toBe(true);
    const alt0 = vdist(e.pos, p.pos) - p.radius;
    meta.input.thrustUp = 1; // collective up
    runTicks(sim, 20 * 3);
    const alt1 = vdist(e.pos, p.pos) - p.radius;
    expect(alt1).toBeGreaterThan(alt0 + 100); // climbed vertically despite a level nose
  });

  it('VTOL hovers: releasing the stick snaps a drifting ship to a near-stop', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    sim.toggleVtol(pid);
    e.vel = v3(40, 0, 10); // drifting, hands off the controls
    runTicks(sim, 20 * 3);
    expect(vlen(e.vel)).toBeLessThan(5); // hovered to a stop
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
  // approach a SOLID side face of the box hull (the hangar is on the +f face)
  const stageAtStation = (sim: Sim, speed: number) => {
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.undockInvuln = 0;
    meta.flightAssist = false; // coast straight in, deterministic
    const st = sim.system.stations[0];
    const fr = hangarFrame(st);
    const core = fr.HX;       // the +u face of the hull box
    const dir = fr.u;
    e.pos = vadd(st.pos, vscale(dir, core + e.radius + 5));
    e.vel = vscale(dir, -speed); // straight into the hull
    return { e, st, core };
  };

  it('low-speed contact gently stops/slides — no hard bounce, no clipping', () => {
    const sim = makeSim();
    const { e, st, core } = stageAtStation(sim, 20);
    runTicks(sim, 40);
    expect(vdist(e.pos, st.pos)).toBeGreaterThanOrEqual(core + e.radius - 1); // never inside
    expect(vlen(e.vel)).toBeLessThan(20); // not flung away
  });

  it('high-speed impact damages the hull proportionally and still resolves cleanly', () => {
    const sim = makeSim();
    const { e, st, core } = stageAtStation(sim, 400);
    const hull0 = e.hull;
    runTicks(sim, 5);
    expect(e.hull).toBeLessThan(hull0);
    expect(vdist(e.pos, st.pos)).toBeGreaterThanOrEqual(core + e.radius - 1);
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
      const fr = hangarFrame(st);
      const dir = fr.u;
      e.pos = vadd(st.pos, vscale(dir, fr.HX + e.radius + 5));
      e.vel = vscale(dir, -300);
      const h0 = e.hull;
      runTicks(sim, 5);
      return h0 - e.hull;
    };
    expect(dmg(2.5)).toBeGreaterThan(dmg(0.8));
  });
});

describe('docking', () => {
  // set the ship down on the landing pad inside the hangar, gear + VTOL, slow:
  // the skill-landing end state the sim docks on
  const stageOnPad = (sim: Sim, pid: number, st: { id: string }) => {
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    const def = sim.station(st.id)!;
    meta.undockInvuln = 0;
    meta.gearDown = true;
    meta.vtol = true;
    e.pos = padPoint(def);
    e.vel = v3();
    e.orient = qLookAt(vscale(hangarFrame(def).f, -1)); // nose into the bay
  };

  it('flying into the hangar and setting down on the pad docks you (#5/#17)', () => {
    const sim = makeSim();
    const st = sim.system.stations[0];
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    stageOnPad(sim, pid, st);
    runTicks(sim, 8); // settles on the pad and the dock is logged in place
    expect(sim.entities.get(pid)!.dockedAt).toBe(st.id);
  });

  it('undocks cleanly', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    const e = sim.entities.get(pid)!;
    expect(e.dockedAt).toBe('morrow_granary'); // starts docked
    sim.undock(pid);
    expect(e.dockedAt).toBeNull();
  });

  it('you can fly in through the open hatch into the hangar (#5)', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.undockInvuln = 0;
    meta.flightAssist = false;
    const st = sim.system.stations[0];
    const fr = hangarFrame(st);
    const mouth = vadd(st.pos, vscale(fr.f, fr.HZ));
    e.pos = vadd(mouth, vscale(fr.f, 150)); // just outside the slot, lined up
    e.orient = qLookAt(vscale(fr.f, -1));
    e.vel = vscale(fr.f, -50); // drift straight in, under the hull
    runTicks(sim, 20 * 8);
    const rel = vsub(e.pos, st.pos);
    const a = vdot(rel, fr.f), pu = vdot(rel, fr.u), pv = vdot(rel, fr.v);
    expect(a).toBeLessThan(fr.mouthA);     // made it past the mouth plane
    expect(a).toBeGreaterThan(fr.backA);   // not pushed through the back wall
    expect(Math.abs(pu)).toBeLessThan(fr.HW); // still within the slot, not ejected
    expect(Math.abs(pv)).toBeLessThan(fr.HH);
  });

  it('will not dock you while still outside the hangar — no auto-suck (#17)', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    const st = sim.station('morrow_granary')!;
    meta.undockInvuln = 0;
    meta.gearDown = true;
    meta.vtol = true;
    // hover beside the solid hull, in dock range but not inside the hangar
    const fr = hangarFrame(st);
    e.pos = vadd(st.pos, vscale(fr.u, fr.HX + e.radius + 600));
    e.vel = v3();
    sim.requestDock(pid);     // manual key: should be a wave-off
    runTicks(sim, 30);        // and no passive suck-in either
    expect(e.dockedAt).toBeNull();
  });

  it('autodock flies an out-of-position ship onto the pad for a fee (#17)', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.undockInvuln = 0;
    meta.profile.credits = 1000;
    const st = sim.station('morrow_granary')!;
    const fr = hangarFrame(st);
    e.pos = vadd(st.pos, vscale(fr.f, fr.HZ + 1500)); // in front of the hatch, in range
    e.vel = v3();
    sim.autodock(pid);
    runTicks(sim, 20 * 5); // autopilot eases all the way onto the pad
    expect(e.dockedAt).toBe('morrow_granary');
    expect(meta.profile.credits).toBe(500);
  });

  it('refuses docking when too fast or too far', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.undockInvuln = 0;
    const st = sim.station('morrow_granary')!;
    stageOnPad(sim, pid, st);
    e.vel = vscale(hangarFrame(st).f, 200); // on the pad but screaming — too fast
    sim.requestDock(pid);
    runTicks(sim, 2);
    expect(e.dockedAt).toBeNull();
    e.vel = v3();
    e.pos = vadd(st.pos, vscale(hangarFrame(st).f, 80_000)); // out of range
    sim.requestDock(pid);
    runTicks(sim, 2);
    expect(e.dockedAt).toBeNull();
  });
});

describe('planetary atmosphere & landing (#16)', () => {
  const landablePlanet = (sim: Sim) => sim.system.planets.find((p) => isLandable(p.kind))!;

  it('atmospheric drag bleeds speed near a planet', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.flightAssist = false;
    const p = landablePlanet(sim);
    e.pos = vadd(p.pos, vscale(v3(0, 1, 0), p.radius + 10_000)); // inside the air shell
    e.vel = v3(300, 0, 0); // tangential, so we don't hit the surface
    const v0 = vlen(e.vel);
    runTicks(sim, 20 * 3);
    expect(vlen(e.vel)).toBeLessThan(v0 * 0.9);
  });

  it('slow gear-down touchdown is clean; gear-up slam damages the hull (#18)', () => {
    const land = (gearDown: boolean, speed: number) => {
      const sim = makeSim();
      const pid = sim.addPlayer('tester');
      sim.undock(pid);
      const e = sim.entities.get(pid)!;
      const meta = sim.meta(pid)!;
      meta.flightAssist = false;
      meta.undockInvuln = 0;
      meta.gearDown = gearDown;
      e.maxHull = e.hull = 100_000;
      const p = landablePlanet(sim);
      const up = v3(0, 1, 0);
      e.pos = vadd(p.pos, vscale(up, p.radius + e.radius + 5));
      e.vel = vscale(up, -speed); // straight down
      const h0 = e.hull;
      runTicks(sim, 12);
      return { dmg: h0 - e.hull, alt: vdist(e.pos, p.pos) - p.radius };
    };
    const soft = land(true, 20);
    expect(soft.dmg).toBe(0);              // gear down + gentle = no damage
    expect(soft.alt).toBeGreaterThan(-1);  // rests on the surface, no clipping
    expect(land(false, 200).dmg).toBeGreaterThan(0); // gear up + fast = hull damage
  });

  it('touchdown is announced once, not every tick (onSurface rising edge)', () => {
    const sim = makeSim();
    const pid = sim.addPlayer('tester');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    const meta = sim.meta(pid)!;
    meta.flightAssist = false;
    meta.undockInvuln = 0;
    meta.gearDown = true;
    const p = landablePlanet(sim);
    e.pos = vadd(p.pos, vscale(v3(0, 1, 0), p.radius + e.radius + 3));
    e.vel = vscale(v3(0, 1, 0), -10);
    const events: any[] = [];
    for (let i = 0; i < 40; i++) events.push(...sim.tick());
    const touchdowns = events.filter((ev) => ev.type === 'log' && typeof ev.text === 'string' && ev.text.includes('Touchdown'));
    expect(touchdowns.length).toBe(1);
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
