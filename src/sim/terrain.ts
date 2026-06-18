// Shared deterministic terrain heightfield. The SAME function feeds the near
// render patch (so you see it) and the sim's ground collision (so you land on
// it) — no flying through visible mountains, no floating over valleys. Pure
// math (fbm2 from rng), no THREE, so it runs identically in the browser and the
// Node server.

import { fbm2 } from './rng';
import type { PlanetKind } from './types';
import { vlen, vsub, type Vec3 } from './vec';

export interface TerrainBody { pos: Vec3; radius: number; kind: PlanetKind; colorSeed: number; }

// relief amplitude (m), horizontal feature scale and whether ridges are sharp,
// per world kind. Colours live in the renderer; this is just the shape.
export const TERRAIN: Record<PlanetKind, { amp: number; freq: number; ridged: boolean }> = {
  rocky:  { amp: 2200, freq: 1.0, ridged: true },
  terran: { amp: 1900, freq: 0.95, ridged: true },
  barren: { amp: 2000, freq: 1.1, ridged: true },
  ice:    { amp: 1300, freq: 0.8, ridged: false },
  lava:   { amp: 2100, freq: 1.2, ridged: true },
  gas:    { amp: 700, freq: 0.6, ridged: false },
};

// Height (m above the mean sphere) at a world (X,Z) for a given world.
//
// The shape is built for DRAMATIC, Elite-Dangerous-like relief that reads from
// altitude: broad rolling plains EVERYWHERE, with isolated mountain MASSIFS
// rising several km where a large-scale "continental" mask is high — rather than
// uniform bumpiness that foreshortens to a flat wash from high up. A low-freq
// domain warp meanders the ridgelines; seven ridged octaves carry the fine
// ridge detail you read on the way down.
export function heightField(X: number, Z: number, seed: number, p: { amp: number; freq: number; ridged: boolean }): number {
  const f = 0.00011 * p.freq;
  const wx = fbm2(X * f * 0.35 + 19, Z * f * 0.35, seed + 711, 1) - 0.5;
  const wy = fbm2(X * f * 0.35, Z * f * 0.35 - 23, seed + 913, 1) - 0.5;
  const uu = X + wx * 4200;
  const vv = Z + wy * 4200;
  // continental mask (2-octave, large scale): 0 over lowland plains, rising over
  // highland belts. We square the upper range into a MASSIF mask so mountains
  // cluster into ranges with broad plains between, not an even field of bumps.
  const cont = fbm2(uu * f * 0.30, vv * f * 0.30, seed + 41, 2);
  const massif = Math.pow(Math.max(0, cont - 0.30) / 0.70, 1.0); // 0 on plains -> 1 deep in a range; linear ramp gives foothills, not abrupt spikes
  // Split the shape so mountains are BROAD MASSIFS, not needles:
  //  - a low-frequency BODY (4 big octaves) gives the broad mountain mass that the
  //    massif mask lifts into tall ranges;
  //  - a high-frequency DETAIL pass (3 fine octaves) adds rugged ridge texture at
  //    a modest, uniform amplitude so it reads as rock up close without spiking
  //    the peaks into thin spires.
  let body = 0, amp = 1, freq = 1, bnorm = 0;
  for (let o = 0; o < 4; o++) {
    let n = fbm2(uu * f * freq, vv * f * freq, seed + o * 131, 1);
    if (p.ridged) n = 1 - Math.abs(n * 2 - 1);
    body += n * amp; bnorm += amp; amp *= 0.5; freq *= 2.1;
  }
  body /= bnorm;
  if (p.ridged) body = Math.pow(body, 1.25);
  let detail = 0, damp = 1, dfreq = 9, dnorm = 0;
  for (let o = 0; o < 3; o++) {
    let n = fbm2(uu * f * dfreq, vv * f * dfreq, seed + o * 257 + 5, 1);
    if (p.ridged) n = 1 - Math.abs(n * 2 - 1);
    detail += n * damp; dnorm += damp; damp *= 0.5; dfreq *= 2.1;
  }
  detail = detail / dnorm - 0.5; // centered, so it only textures the body
  // gentle rolling plains everywhere + tall broad ranges where the massif mask is
  // high. Peaks reach ~2x the per-kind amplitude. The big dynamic range is what
  // makes the relief read from km up; the detail rides on top for close-up rock.
  const plains = body * 0.42;
  const ranges = body * massif * 1.65;
  return ((plains + ranges) + detail * 0.16) * p.amp;
}

// Sub-point on the sphere directly under `pos` (where the column of terrain the
// ship sits over is anchored), in world X/Z — the value the render patch uses at
// its centre, so collision and visuals agree on the ground height beneath you.
function subPoint(body: TerrainBody, pos: Vec3): { x: number; z: number } {
  const dx = pos.x - body.pos.x, dy = pos.y - body.pos.y, dz = pos.z - body.pos.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  return { x: body.pos.x + dx / d * body.radius, z: body.pos.z + dz / d * body.radius };
}

// Terrain height (m above mean radius) directly beneath a world position.
export function terrainHeight(body: TerrainBody, pos: Vec3): number {
  const s = subPoint(body, pos);
  return heightField(s.x, s.z, body.colorSeed, TERRAIN[body.kind]);
}

// Outward surface normal of the terrain beneath a position, tilted by the local
// slope so a steep face pushes the ship sideways (you slide off ridges instead
// of sticking to them). Finite-difference of the heightfield along the tangent.
export function terrainNormal(body: TerrainBody, pos: Vec3): Vec3 {
  const up = unit(vsub(pos, body.pos));
  // a stable tangent basis (matches the render patch)
  const ref: Vec3 = Math.abs(up.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const t1 = unit(cross(ref, up));
  const t2 = unit(cross(up, t1));
  const s = subPoint(body, pos);
  const prm = TERRAIN[body.kind];
  const seed = body.colorSeed;
  const e = 24; // metres
  const h0 = heightField(s.x, s.z, seed, prm);
  const s1 = (heightField(s.x + t1.x * e, s.z + t1.z * e, seed, prm) - h0) / e;
  const s2 = (heightField(s.x + t2.x * e, s.z + t2.z * e, seed, prm) - h0) / e;
  // normal = up minus the slope contributions along the tangent axes
  return unit({
    x: up.x - t1.x * s1 - t2.x * s2,
    y: up.y - t1.y * s1 - t2.y * s2,
    z: up.z - t1.z * s1 - t2.z * s2,
  });
}

function unit(v: Vec3): Vec3 {
  const l = vlen(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
