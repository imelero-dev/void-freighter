import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { surfaceEnvAt, surfaceRadius } from '../src/sim/surface';
import { qLookAt, v3, vadd, vdist, vdot, vlen, vnorm, vscale, vsub } from '../src/sim/vec';

function runTicks(sim: Sim, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...sim.tick());
  return events;
}

function pilot(sim: Sim) {
  const pid = sim.addPlayer('lander');
  sim.undock(pid);
  const e = sim.entities.get(pid)!;
  const meta = sim.meta(pid)!;
  meta.undockInvuln = 0;
  meta.interdictCooldown = 1e9;
  return { pid, e, meta };
}

describe('surface model determinism (#16)', () => {
  it('terrain height is deterministic and pads sit on their flattened bench', () => {
    const a = new Sim(), b = new Sim();
    const bodyA = a.surfaceBodies.find((x) => x.pads.length > 0)!;
    const bodyB = b.surfaceBodies.find((x) => x.id === bodyA.id)!;
    const dir = vnorm(v3(0.3, 0.5, 0.8));
    expect(surfaceRadius(bodyA, dir)).toBe(surfaceRadius(bodyB, dir));
    for (const pad of bodyA.pads) {
      const up = vnorm(vsub(pad.pos, bodyA.pos));
      // pad deck matches the terrain bench beneath it
      expect(Math.abs(vdist(pad.pos, bodyA.pos) - surfaceRadius(bodyA, up))).toBeLessThan(3);
    }
  });
});

describe('atmospheric entry (#16)', () => {
  it('drag scrubs speed inside the atmosphere', () => {
    const sim = new Sim();
    const { e, meta } = pilot(sim);
    const body = sim.surfaceBodies.find((x) => x.kind === 'terran')!;
    meta.flightAssist = false; // no assist: only drag can slow us
    const up = v3(1, 0, 0);
    e.pos = vadd(body.pos, vscale(up, body.radius * 1.10));
    // fly tangentially so we don't just hit the ground
    e.vel = v3(0, 0, 260);
    runTicks(sim, 20 * 5);
    expect(vlen(e.vel)).toBeLessThan(245); // drag bit off a chunk
  });

  it('gravity pulls a coasting ship down toward the surface', () => {
    const sim = new Sim();
    const { e, meta } = pilot(sim);
    const body = sim.surfaceBodies.find((x) => x.kind === 'barren')!; // vacuum world: gravity, no drag
    meta.flightAssist = false;
    const up = v3(1, 0, 0);
    e.pos = vadd(body.pos, vscale(up, body.radius * 1.2));
    e.vel = v3();
    const d0 = vdist(e.pos, body.pos);
    runTicks(sim, 20 * 12);
    expect(vdist(e.pos, body.pos)).toBeLessThan(d0 - 150);
  });

  it('cruise drive drops out at the atmospheric interface', () => {
    const sim = new Sim();
    const { e, meta } = pilot(sim);
    const body = sim.surfaceBodies.find((x) => x.kind === 'terran')!;
    e.pos = vadd(body.pos, v3(body.radius * 2.5, 0, 0));
    e.cruise = 'cruise';
    e.cruiseSpeed = 3000;
    e.orient = qLookAt(vnorm(vsub(body.pos, e.pos)));
    meta.destination = null;
    // teleport-step into the atmosphere while 'cruising'
    e.pos = vadd(body.pos, v3(body.radius * 1.12, 0, 0));
    const events = runTicks(sim, 5);
    expect(e.cruise).toBe('off');
    expect(events.some((ev) => ev.type === 'log' && /Atmospheric interface/.test((ev as any).text))).toBe(true);
  });
});

describe('VTOL + gear + touchdown (#18/#19)', () => {
  it('gear deploys over time via toggle and reports state', () => {
    const sim = new Sim();
    const { pid, meta } = pilot(sim);
    expect(meta.gear).toBe(0);
    expect(sim.toggleGear(pid)).toBe(true);
    runTicks(sim, 10); // 0.5 s: still cycling
    expect(meta.gear).toBeGreaterThan(0);
    expect(meta.gear).toBeLessThan(1);
    runTicks(sim, 40);
    expect(meta.gear).toBe(1);
    expect(sim.toggleGear(pid)).toBe(false);
    runTicks(sim, 50);
    expect(meta.gear).toBe(0);
  });

  it('VTOL toggles in flight and hovers against gravity with assist on', () => {
    const sim = new Sim();
    const { pid, e, meta } = pilot(sim);
    expect(sim.toggleVtol(pid)).toBe(true);
    expect(meta.vtol).toBe(true);
    const body = sim.surfaceBodies.find((x) => x.kind === 'barren')!;
    const up = v3(1, 0, 0);
    e.pos = vadd(body.pos, vscale(up, body.radius * 1.05));
    e.vel = v3();
    const d0 = vdist(e.pos, body.pos);
    runTicks(sim, 20 * 4);
    // hover assist nulls gravity: barely any sink
    expect(Math.abs(vdist(e.pos, body.pos) - d0)).toBeLessThan(30);
  });

  it('gear-down slow descent lands; ship rests and lifts off again seamlessly', () => {
    const sim = new Sim();
    const { pid, e, meta } = pilot(sim);
    const body = sim.surfaceBodies.find((x) => x.kind === 'barren')!;
    const up = vnorm(v3(0.4, 0.7, 0.6));
    const surfR = surfaceRadius(body, up);
    sim.toggleGear(pid);
    sim.toggleVtol(pid);
    runTicks(sim, 40); // gear down
    e.pos = vadd(body.pos, vscale(up, surfR + 120));
    e.vel = vscale(up, -6); // gentle sink
    meta.input.thrustForward = 0;
    let events: any[] = [];
    for (let i = 0; i < 20 * 30 && !meta.landedOn; i++) {
      // VTOL hover would null the sink; push down gently like a pilot would
      e.vel = vscale(up, -6);
      events.push(...sim.tick());
    }
    expect(meta.landedOn).toBe(body.id);
    expect(vlen(e.vel)).toBe(0);
    expect(events.some((ev) => ev.type === 'touchdown' && !ev.hard)).toBe(true);
    expect(e.hull).toBe(e.maxHull); // soft landing: no damage
    // parked: stays put
    runTicks(sim, 20 * 3);
    expect(meta.landedOn).toBe(body.id);
    // throttle up to lift off — no cuts, no transitions
    meta.input.thrustUp = 1;
    meta.input.thrustForward = 0.5;
    runTicks(sim, 20 * 3);
    expect(meta.landedOn).toBeNull();
    expect(vdist(e.pos, body.pos)).toBeGreaterThan(surfR + 30);
  });

  it('slamming in gear-up deals proportional hull damage (#18)', () => {
    const sim = new Sim();
    const { e, meta } = pilot(sim);
    const body = sim.surfaceBodies.find((x) => x.kind === 'barren')!;
    const up = vnorm(v3(0.4, 0.7, 0.6));
    const surfR = surfaceRadius(body, up);
    meta.flightAssist = false;
    e.pos = vadd(body.pos, vscale(up, surfR + 30));
    e.vel = vscale(up, -25); // past any survivable gear-up contact
    const events = runTicks(sim, 20 * 3);
    expect(e.hull).toBeLessThan(e.maxHull);
    expect(e.hull).toBeGreaterThan(0); // proportional, not instantly lethal
    expect(events.some((ev) => ev.type === 'touchdown' && ev.hard)).toBe(true);
  });
});

describe('pad docking + ATC (#17/#20)', () => {
  it('planetary approach clearance lists pads; landing on the assigned pad docks', () => {
    const sim = new Sim();
    const { pid, e, meta } = pilot(sim);
    const body = sim.surfaceBodies.find((x) => x.pads.length > 0)!;
    const pad = body.pads[0];
    // arrive high over the port and request clearance
    e.pos = vadd(pad.pos, vscale(pad.up, 5000));
    e.vel = v3();
    const events = runTicks(sim, 2);
    sim.requestDock(pid);
    const clear = sim.tick();
    const apprEv: any = [...events, ...clear].find((ev) => ev.type === 'approach');
    expect(meta.approach?.targetId).toBe(body.id);
    expect(apprEv?.options.length).toBeGreaterThanOrEqual(3);
    // reassign to pad 2 and back — ATC obeys
    sim.selectDockSlot(pid, body.pads[1].id);
    expect(meta.approach?.slot).toBe(body.pads[1].id);
    sim.selectDockSlot(pid, pad.id);
    // gear down, sink onto the pad center
    sim.toggleGear(pid);
    sim.toggleVtol(pid);
    runTicks(sim, 40);
    e.pos = vadd(pad.pos, vscale(pad.up, 60));
    for (let i = 0; i < 20 * 20 && !e.dockedAt; i++) {
      e.vel = vscale(pad.up, -5);
      sim.tick();
    }
    expect(e.dockedAt).toBe(body.stationId);
    // undock: back on the pad, parked, gear down — take off manually (#16)
    sim.undock(pid);
    expect(e.dockedAt).toBeNull();
    expect(meta.landedOn).toBe(body.id);
    expect(vdist(e.pos, pad.pos)).toBeLessThan(pad.radius);
  });

  it('ATC waves off a hot approach (#20)', () => {
    const sim = new Sim();
    const { pid, e } = pilot(sim);
    const st = sim.system.stations.find((s) => s.id === 'morrow_granary')!;
    e.pos = vadd(st.pos, vscale(st.bayDir, 4000));
    e.vel = v3();
    sim.requestDock(pid);
    // dive at the mouth way too fast
    e.pos = vadd(st.pos, vscale(st.bayDir, st.radius * BAYISH));
    e.vel = vscale(st.bayDir, -220);
    const events = runTicks(sim, 10);
    expect(events.some((ev) => ev.type === 'comms' && /Go around/.test((ev as any).text))).toBe(true);
  });
});

// bay mouth is at radius*1.06 (docking.ts); keep the test readable
const BAYISH = 1.55;
