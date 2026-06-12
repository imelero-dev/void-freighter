// Mining bot: flies to a belt field, drills rocks, collects fragments,
// refines the ore at a station and sells the result. Fails without profit.

import { loadSim } from './lib/sim_loader.mjs';

const { Sim, GOODS, REFINE_RECIPES, qLookAt, vadd, vdist, vnorm, vscale, vsub, v3 } = await loadSim();

const sim = new Sim();
const pid = sim.addPlayer('MineBot');
const meta = sim.meta(pid);
const e = sim.entities.get(pid);
sim.undock(pid);
meta.profile.modules.drill = 2;
meta.profile.modules.collector = 3;
sim.recomputeStats(pid);
meta.interdictCooldown = 1e9;
const startCredits = meta.profile.credits;
console.log(`▶ smoke_mine — drill Mk2 fitted, credits: ${startCredits}`);

// park in the first ironline field
const field = sim.system.belts[0].fields[0];
e.pos = { ...field.pos };
e.vel = v3();
meta.undockInvuln = 1e9; // bot is here to mine, not to dogfight
for (let i = 0; i < 30; i++) sim.tick();

const minedTarget = 30;
let safety = 20 * 240; // 4 min sim budget
while (meta.profile.stats.unitsMined < minedTarget && safety-- > 0) {
  // nearest live rock
  let rock = null;
  let bestD = Infinity;
  for (const t of sim.entities.values()) {
    if (t.kind !== 'asteroid') continue;
    const d = vdist(t.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      rock = t;
    }
  }
  if (!rock) break;
  // hop next to it, aim, drill
  e.pos = vadd(rock.pos, vscale(vnorm(vsub(e.pos, rock.pos)), rock.radius + 180));
  e.vel = v3();
  e.orient = qLookAt(vnorm(vsub(rock.pos, e.pos)));
  sim.setTarget(pid, rock.id);
  sim.setDrill(pid, true);
  sim.tick();
}
const mined = meta.profile.stats.unitsMined;
console.log(`mined ${mined} units: ${meta.profile.cargo.map((c) => `${c.qty}× ${GOODS[c.good].name}`).join(', ') || 'nothing'}`);
if (mined < 10) {
  console.error('❌ mining yield too low');
  process.exit(1);
}

// refine everything refinable at Cinder Forge (eff 0.9), then sell all
e.dockedAt = 'cinder_forge';
for (const r of REFINE_RECIPES) {
  const have = sim.freeQty(meta.profile, r.input);
  if (have > 0) sim.refine(pid, r.input, have);
}
console.log(`after refining: ${meta.profile.cargo.map((c) => `${c.qty}× ${GOODS[c.good].name}`).join(', ')}`);
for (const c of [...meta.profile.cargo]) {
  sim.sellGood(pid, c.good, c.qty);
}
const final = meta.profile.credits;
console.log(`sold everything — net ${final - startCredits >= 0 ? '+' : ''}${final - startCredits} cr`);
if (final <= startCredits) {
  console.error('❌ mining run lost money');
  process.exit(1);
}
console.log('✅ smoke_mine passed — the belt provides');
