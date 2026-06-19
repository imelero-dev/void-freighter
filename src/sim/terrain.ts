// Shared deterministic terrain heightfield. The SAME function feeds the near
// render patch (so you see it) and the sim's ground collision (so you land on
// it) — no flying through visible mountains, no floating over valleys. Pure
// math (fbm2 from rng), no THREE, so it runs identically in the browser and the
// Node server.

import { fbm2, fbm3 } from './rng';
import type { PlanetKind } from './types';
import { vlen, vsub, type Vec3 } from './vec';

export interface TerrainBody { pos: Vec3; radius: number; kind: PlanetKind; colorSeed: number; }

// relief amplitude (m), horizontal feature scale and whether ridges are sharp,
// per world kind. Colours live in the renderer; this is just the shape.
export const TERRAIN: Record<PlanetKind, { amp: number; freq: number; ridged: boolean }> = {
  rocky:  { amp: 3000, freq: 1.0, ridged: true },
  terran: { amp: 2600, freq: 0.95, ridged: true },
  barren: { amp: 2800, freq: 1.1, ridged: true },
  ice:    { amp: 1800, freq: 0.8, ridged: false },
  lava:   { amp: 2900, freq: 1.2, ridged: true },
  gas:    { amp: 900, freq: 0.6, ridged: false },
};

// Height (m above the mean sphere) at a point on the planet, given the direction
// (dx,dy,dz) from the planet CENTRE toward that surface point (need not be unit).
//
// CRITICAL: the terrain is sampled with 3-D noise on the unit SPHERE DIRECTION,
// not on a flat (X,Z) projection. A planet is a sphere; sampling height from
// world X/Z alone is a cylindrical projection that is degenerate wherever the
// local "up" tilts toward the XZ plane — it stretches features into spikes,
// corrupts the surface normals (so the ground goes dark and faceted) and makes
// the patch fail to scroll as you fly. Sampling fbm3 on the direction is
// seamless everywhere on the globe: no poles, no spikes, consistent relief.
//
// The shape is built for DRAMATIC, Elite-Dangerous-like relief that reads from
// altitude: broad rolling plains EVERYWHERE, with isolated mountain MASSIFS
// rising several km where a large-scale "continental" mask is high. A low-freq
// domain warp meanders the ridgelines; ridged octaves carry the fine detail.
export function heightField(dx: number, dy: number, dz: number, radius: number, seed: number, p: { amp: number; freq: number; ridged: boolean }): number {
  const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
  const nx = dx * inv, ny = dy * inv, nz = dz * inv;
  // noise-space scale: maps ~10 km surface features to one noise period, the
  // same feature size the old planar field used (radius * metres-per-noise-unit)
  const S = radius * 0.00011 * p.freq;
  const sx = nx * S, sy = ny * S, sz = nz * S;
  // 3-D domain warp (1 octave) so ridgelines meander instead of running straight
  const wx = fbm3(sx * 0.35 + 19, sy * 0.35, sz * 0.35, seed + 711, 1) - 0.5;
  const wy = fbm3(sx * 0.35, sy * 0.35 + 7, sz * 0.35 - 23, seed + 913, 1) - 0.5;
  const wz = fbm3(sx * 0.35 - 11, sy * 0.35, sz * 0.35 + 5, seed + 277, 1) - 0.5;
  const ux = sx + wx * 0.46, uy = sy + wy * 0.46, uz = sz + wz * 0.46;
  // continental mask (2-octave, large scale): 0 over lowland plains, rising over
  // highland belts. The massif mask clusters mountains into ranges with broad
  // plains between, not an even field of bumps.
  const cont = fbm3(ux * 0.30, uy * 0.30, uz * 0.30, seed + 41, 2);
  const massif = Math.max(0, cont - 0.30) / 0.70; // 0 on plains -> 1 deep in a range
  // BODY: 3 big octaves give the broad mountain mass the massif mask lifts. (This
  // is sampled per render vertex thousands of times per rebuild, so octave count
  // is a direct CPU cost — 3 keeps the massifs while staying cheap.)
  let body = 0, amp = 1, freq = 1, bnorm = 0;
  for (let o = 0; o < 3; o++) {
    let n = fbm3(ux * freq, uy * freq, uz * freq, seed + o * 131, 1);
    if (p.ridged) n = 1 - Math.abs(n * 2 - 1);
    body += n * amp; bnorm += amp; amp *= 0.5; freq *= 2.1;
  }
  body /= bnorm;
  if (p.ridged) body = Math.pow(body, 1.25);
  // DETAIL: 2 fine octaves add rugged ridge texture at a modest amplitude (the
  // per-pixel shader detail carries the finest scale, so the mesh needn't).
  let detail = 0, damp = 1, dfreq = 9, dnorm = 0;
  for (let o = 0; o < 2; o++) {
    let n = fbm3(ux * dfreq, uy * dfreq, uz * dfreq, seed + o * 257 + 5, 1);
    if (p.ridged) n = 1 - Math.abs(n * 2 - 1);
    detail += n * damp; dnorm += damp; damp *= 0.5; dfreq *= 2.1;
  }
  detail = detail / dnorm - 0.5; // centered, so it only textures the body
  // gentle rolling plains everywhere + tall broad ranges where the massif mask is
  // high. Peaks reach ~2x the per-kind amplitude — the big dynamic range is what
  // makes the relief read from km up; the detail rides on top for close-up rock.
  const plains = body * 0.42;
  const ranges = body * massif * 2.6; // tall, dramatic ranges that read from km up
  return ((plains + ranges) + detail * 0.16) * p.amp;
}

// Conservative upper bound on heightField output for a world kind (m above the
// mean sphere). The shape maxes at ~(plains 0.42 + ranges 2.6 + detail 0.08)·amp;
// 3.2·amp covers it with margin. Collision uses this to know how far above the
// mean radius it must still test for terrain — TOO LOW a bound lets the ship fly
// freely INTO a tall peak, then a single huge correction when it finally tests
// reads as a massive impact and kills you ("sudden death on entry").
export function maxRelief(kind: PlanetKind): number {
  return TERRAIN[kind].amp * 3.2;
}

// Terrain height (m above mean radius) directly beneath a world position.
export function terrainHeight(body: TerrainBody, pos: Vec3): number {
  const dx = pos.x - body.pos.x, dy = pos.y - body.pos.y, dz = pos.z - body.pos.z;
  return heightField(dx, dy, dz, body.radius, body.colorSeed, TERRAIN[body.kind]);
}

// Outward surface normal of the terrain beneath a position, tilted by the local
// slope so a steep face pushes the ship sideways (you slide off ridges instead
// of sticking to them). Finite-difference of the heightfield along the surface.
export function terrainNormal(body: TerrainBody, pos: Vec3): Vec3 {
  const up = unit(vsub(pos, body.pos));
  // a stable tangent basis (matches the render patch)
  const ref: Vec3 = Math.abs(up.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const t1 = unit(cross(ref, up));
  const t2 = unit(cross(up, t1));
  const prm = TERRAIN[body.kind];
  const seed = body.colorSeed;
  const R = body.radius;
  const e = 24; // metres along the surface
  const ea = e / R; // matching angular step on the sphere
  const hf = (vx: number, vy: number, vz: number) => heightField(vx, vy, vz, R, seed, prm);
  const h0 = hf(up.x, up.y, up.z);
  // sample at directions nudged along each surface tangent by `e` metres
  const s1 = (hf(up.x + t1.x * ea, up.y + t1.y * ea, up.z + t1.z * ea) - h0) / e;
  const s2 = (hf(up.x + t2.x * ea, up.y + t2.y * ea, up.z + t2.z * ea) - h0) / e;
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
