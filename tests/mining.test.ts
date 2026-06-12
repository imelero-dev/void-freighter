import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { rockSpawn } from '../src/sim/system';
import { qLookAt, vadd, vnorm, vsub, vscale, v3 } from '../src/sim/vec';

function runTicks(sim: Sim, n: number) {
  for (let i = 0; i < n; i++) sim.tick();
}

function minerInField(sim: Sim) {
  const pid = sim.addPlayer('miner');
  sim.undock(pid);
  const meta = sim.meta(pid)!;
  meta.profile.modules.drill = 2;
  meta.profile.modules.collector = 2;
  sim.recomputeStats(pid);
  const field = sim.system.belts[0].fields[0];
  const e = sim.entities.get(pid)!;
  e.pos = { ...field.pos };
  e.vel = v3();
  meta.undockInvuln = 0;
  runTicks(sim, 25); // let the field activate
  return { pid, e, meta, field };
}

describe('asteroid fields', () => {
  it('rock placement is deterministic', () => {
    const sys = new Sim().system;
    const belt = sys.belts[0];
    const field = belt.fields[0];
    const a = rockSpawn(field, belt, 3);
    const b = rockSpawn(field, belt, 3);
    expect(a).toEqual(b);
  });

  it('activates asteroid entities when a player is near', () => {
    const sim = new Sim();
    const { field } = minerInField(sim);
    const rocks = [...sim.entities.values()].filter((x) => x.kind === 'asteroid' && x.fieldId === field.id);
    expect(rocks.length).toBeGreaterThan(20);
  });

  it('deactivates when the player leaves', () => {
    const sim = new Sim();
    const { e, field } = minerInField(sim);
    e.pos = v3(1e6, 1e6, 1e6);
    runTicks(sim, 40);
    const rocks = [...sim.entities.values()].filter((x) => x.kind === 'asteroid' && x.fieldId === field.id);
    expect(rocks.length).toBe(0);
  });
});

describe('mining cycle', () => {
  it('drilling damages the rock, spawns fragments, collector picks them up', () => {
    const sim = new Sim();
    const { pid, e, meta } = minerInField(sim);
    const rock = [...sim.entities.values()]
      .filter((x) => x.kind === 'asteroid')
      .sort((a, b) => distOf(a, e) - distOf(b, e))[0];
    expect(rock).toBeTruthy();
    // park next to the rock and aim
    e.pos = vadd(rock.pos, vscale(vnorm(vsub(e.pos, rock.pos)), rock.radius + 150));
    e.vel = v3();
    e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
    sim.setTarget(pid, rock.id);
    sim.setDrill(pid, true);
    sim.setMiningBeam(pid, true);
    const hpBefore = rock.rockHp;
    for (let i = 0; i < 20 * 40; i++) {
      e.vel = v3(); // hold position against fragment drift checks
      e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
      sim.tick();
    }
    expect(rock.rockHp).toBeLessThan(hpBefore);
    expect(meta.profile.stats.unitsMined).toBeGreaterThan(0);
    const mined = meta.profile.cargo.reduce((s, c) => s + c.qty, 0);
    expect(mined).toBeGreaterThan(0);
  });

  it('an active beam emits laser events with mining:true (and stops when released)', () => {
    const sim = new Sim();
    const { pid, e } = minerInField(sim);
    const rock = [...sim.entities.values()]
      .filter((x) => x.kind === 'asteroid')
      .sort((a, b) => distOf(a, e) - distOf(b, e))[0];
    e.pos = vadd(rock.pos, vscale(vnorm(vsub(e.pos, rock.pos)), rock.radius + 150));
    e.vel = v3();
    sim.setDrill(pid, true);
    sim.setMiningBeam(pid, true);
    const beams: Array<{ hit: boolean }> = [];
    for (let i = 0; i < 40; i++) {
      e.vel = v3();
      e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
      for (const ev of sim.tick()) {
        if (ev.type === 'laser' && ev.mining) beams.push({ hit: ev.hit });
      }
    }
    // beam FX cadence is every 2nd tick: 40 ticks -> ~20 events
    expect(beams.length).toBeGreaterThanOrEqual(15);
    expect(beams.length).toBeLessThanOrEqual(25);
    expect(beams.some((b) => b.hit)).toBe(true);
    expect(sim.meta(pid)!.beamFiring).toBe(true);

    sim.setMiningBeam(pid, false);
    let after = 0;
    for (let i = 0; i < 20; i++) {
      for (const ev of sim.tick()) {
        if (ev.type === 'laser' && ev.mining) after++;
      }
    }
    expect(after).toBe(0);
    expect(sim.meta(pid)!.beamFiring).toBe(false);
  });

  it('drill requires the module', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('nodrill');
    sim.undock(pid);
    sim.setDrill(pid, true);
    expect(sim.meta(pid)!.drillOn).toBe(false);
  });

  it('the beam overheats under sustained fire and recovers when released', () => {
    const sim = new Sim();
    const { pid, e, meta } = (() => {
      const pid = sim.addPlayer('hothand');
      sim.undock(pid);
      const meta = sim.meta(pid)!;
      meta.profile.modules.drill = 2;
      sim.recomputeStats(pid);
      const field = sim.system.belts[0].fields[0];
      const e = sim.entities.get(pid)!;
      e.pos = { ...field.pos };
      meta.undockInvuln = 1e9;
      for (let i = 0; i < 25; i++) sim.tick();
      return { pid, e, meta };
    })();
    const rock = [...sim.entities.values()].find((x) => x.kind === 'asteroid')!;
    e.pos = vadd(rock.pos, vscale(vnorm(vsub(e.pos, rock.pos)), rock.radius + 150));
    e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
    sim.setDrill(pid, true);
    sim.setMiningBeam(pid, true);
    for (let i = 0; i < 20 * 8; i++) {
      e.vel = { x: 0, y: 0, z: 0 };
      e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
      sim.tick();
    }
    expect(meta.drillOverheated).toBe(true);
    // release: cools and clears
    sim.setMiningBeam(pid, false);
    for (let i = 0; i < 20 * 6; i++) sim.tick();
    expect(meta.drillOverheated).toBe(false);
    expect(meta.drillHeat).toBeLessThan(0.35);
  });

  it('most fragments are regolith; rock yield only drains on real ore', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('seamster');
    sim.undock(pid);
    const meta = sim.meta(pid)!;
    meta.profile.modules.drill = 5;
    meta.profile.modules.collector = 5;
    meta.profile.modules.cargo = 3;
    sim.recomputeStats(pid);
    const field = sim.system.belts[0].fields[0];
    const e = sim.entities.get(pid)!;
    e.pos = { ...field.pos };
    meta.undockInvuln = 1e9;
    for (let i = 0; i < 25; i++) sim.tick();
    const rock = [...sim.entities.values()]
      .filter((x) => x.kind === 'asteroid')
      .sort((a, b) => distOf(a, e) - distOf(b, e))[0];
    e.pos = vadd(rock.pos, vscale(vnorm(vsub(e.pos, rock.pos)), rock.radius + 150));
    sim.setDrill(pid, true);
    sim.setMiningBeam(pid, true);
    for (let i = 0; i < 20 * 60; i++) {
      e.vel = { x: 0, y: 0, z: 0 };
      e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
      sim.tick();
      // keep the beam alive through heat cycles
      if (sim.meta(pid)!.drillOverheated) sim.setMiningBeam(pid, false);
      else sim.setMiningBeam(pid, true);
    }
    const stone = sim.freeQty(meta.profile, 'stone');
    const ore = meta.profile.cargo.filter((c) => c.good !== 'stone').reduce((s2, c) => s2 + c.qty, 0);
    expect(stone + ore).toBeGreaterThan(0);
    expect(stone).toBeGreaterThanOrEqual(ore); // gangue dominates off-seam
  });
});
function distOf(a: { pos: { x: number; y: number; z: number } }, b: { pos: { x: number; y: number; z: number } }) {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
}
