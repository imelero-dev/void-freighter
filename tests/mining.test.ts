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
    const hpBefore = rock.rockHp;
    for (let i = 0; i < 20 * 25; i++) {
      e.vel = v3(); // hold position against fragment drift checks
      e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
      sim.tick();
    }
    expect(rock.rockHp).toBeLessThan(hpBefore);
    expect(meta.profile.stats.unitsMined).toBeGreaterThan(0);
    const mined = meta.profile.cargo.reduce((s, c) => s + c.qty, 0);
    expect(mined).toBeGreaterThan(0);
  });

  it('drill requires the module', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('nodrill');
    sim.undock(pid);
    sim.setDrill(pid, true);
    expect(sim.meta(pid)!.drillOn).toBe(false);
  });
});
function distOf(a: { pos: { x: number; y: number; z: number } }, b: { pos: { x: number; y: number; z: number } }) {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
}
