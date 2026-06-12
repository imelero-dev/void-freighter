// Entry point bundled by sim_loader.mjs for the smoke bots.
export { Sim, defaultProfile, blankEntity } from '../../src/sim/sim';
export { GOODS, HULLS, REFINE_RECIPES } from '../../src/sim/data';
export { generateSystem, rockSpawn, dangerAt } from '../../src/sim/system';
export { Economy } from '../../src/sim/economy';
export { qLookAt, vadd, vdist, vnorm, vscale, vsub, v3 } from '../../src/sim/vec';
