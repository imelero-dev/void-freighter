// Combat bot: deep-space dogfight against a pirate fighter, loot recovery.
// Fails if the bot dies, the pirate survives, or no loot is recovered.

import { loadSim } from './lib/sim_loader.mjs';

const { Sim, qLookAt, vadd, vdist, vnorm, vscale, vsub, v3 } = await loadSim();

const sim = new Sim();
const pid = sim.addPlayer('GunBot');
const meta = sim.meta(pid);
const e = sim.entities.get(pid);
sim.undock(pid);
meta.profile.modules.weapon = 2;
sim.recomputeStats(pid);
e.pos = v3(9e6, 2e6, 9e6);
e.vel = v3();
meta.undockInvuln = 0;
const startCredits = meta.profile.credits;
console.log(`▶ smoke_combat — Pulse Cannon Mk2, hull ${e.hull}/${e.maxHull}`);

const pirate = sim.spawnPirate('fighter', vadd(e.pos, v3(800, 0, 0)));
sim.setTarget(pid, pirate.id);
sim.setFiring(pid, true);

let ticks = 0;
const MAX_TICKS = 20 * 60;
while (sim.entities.has(pirate.id) && ticks++ < MAX_TICKS) {
  const p = sim.entities.get(pirate.id);
  if (!p) break;
  // keep on its tail at ~350 m
  e.orient = qLookAt(vnorm(vsub(p.pos, e.pos)));
  const d = vdist(p.pos, e.pos);
  if (d > 500) e.pos = vadd(p.pos, vscale(vnorm(vsub(e.pos, p.pos)), 350));
  e.vel = v3();
  sim.tick();
  if (e.hull <= 0) {
    console.error('❌ bot was destroyed');
    process.exit(1);
  }
}
if (sim.entities.has(pirate.id)) {
  console.error('❌ pirate survived the time budget');
  process.exit(1);
}
console.log(`pirate destroyed in ${(ticks / 20).toFixed(1)} s — hull ${Math.round(e.hull)}/${e.maxHull}, kills ${meta.profile.stats.kills}`);

// collect the loot container
const loot = [...sim.entities.values()].find((x) => x.kind === 'loot');
if (!loot) {
  console.error('❌ no loot dropped');
  process.exit(1);
}
e.pos = { ...loot.pos };
for (let i = 0; i < 20; i++) sim.tick();
const gained = meta.profile.credits - startCredits;
const cargo = meta.profile.cargo.reduce((s, c) => s + c.qty, 0);
console.log(`loot recovered: +${gained} cr, ${cargo} cargo units`);
if (gained <= 0 && cargo <= 0) {
  console.error('❌ loot pickup failed');
  process.exit(1);
}
console.log('✅ smoke_combat passed — scratch one raider');
