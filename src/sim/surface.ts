// Planetary & moon surfaces: deterministic terrain height, atmosphere and
// landing pads. Shared by the sim (collision, gravity, drag — #16/#21), the
// renderer (near-terrain patches, pad meshes) and the server. No DOM.

import { fbm3 } from './rng';
import type { PlanetDef, SystemDef } from './types';
import { v3, vadd, vcross, vdist, vlen, vnorm, vscale, vsub, type Vec3 } from './vec';

export type SurfaceKind = PlanetDef['kind'] | 'moon';

export interface LandingPad {
  id: string;
  name: string;      // 'PAD 1'
  bodyId: string;
  pos: Vec3;         // world position of the pad deck center
  up: Vec3;          // surface normal (radial, unit)
  radius: number;    // usable deck disc (m)
}

export interface SurfaceBody {
  id: string;
  name: string;
  kind: SurfaceKind;
  pos: Vec3;
  radius: number;
  seed: number;
  solid: boolean;            // gas giants have no landable surface
  stationId: string | null;  // pad docking grants this station's services
  pads: LandingPad[];
  // surface port bench (flattened terrain under the pads)
  portDir: Vec3 | null;      // unit dir from body center to the port
  portRadius: number;        // bench distance from body center
  portFlatAngle: number;     // rad — terrain blends to bench inside this angle
}

export const ATMO_TOP_MULT = 1.18;    // atmosphere outer edge (× body radius)
export const GRAVITY_TOP_MULT = 1.35; // gravity fades in below this (× radius)
export const SURFACE_G = 8;           // m/s² at surface
export const PAD_RADIUS = 42;         // m

// terrain relief amplitude as a fraction of body radius, per kind
const RELIEF: Record<SurfaceKind, number> = {
  lava: 0.010, rocky: 0.012, terran: 0.008, ice: 0.009, barren: 0.013, moon: 0.015, gas: 0,
};

// sea-level-pressure factor per kind (0 = vacuum world: gravity but no drag)
const ATMO_DENSITY: Record<SurfaceKind, number> = {
  gas: 1.35, terran: 1.0, ice: 0.85, lava: 0.7, rocky: 0.35, barren: 0.12, moon: 0,
};

const NOISE_FREQ = 42; // terrain feature wavelength ≈ radius / 42

export function buildSurfaceBodies(system: SystemDef): SurfaceBody[] {
  const out: SurfaceBody[] = [];
  for (const p of system.planets) {
    const solid = p.kind !== 'gas';
    const body: SurfaceBody = {
      id: p.id, name: p.name, kind: p.kind, pos: p.pos, radius: p.radius,
      seed: p.colorSeed, solid, stationId: p.stationId,
      pads: [], portDir: null, portRadius: 0, portFlatAngle: 0,
    };
    if (solid && p.stationId) {
      const st = system.stations.find((s) => s.id === p.stationId);
      if (st) buildPort(body, vnorm(vsub(st.pos, p.pos)));
    }
    out.push(body);
  }
  for (const m of system.moons) {
    out.push({
      id: m.id, name: m.id.replace('_', ' '), kind: 'moon', pos: m.pos, radius: m.radius,
      seed: m.colorSeed, solid: true, stationId: null,
      pads: [], portDir: null, portRadius: 0, portFlatAngle: 0,
    });
  }
  return out;
}

// Surface port: a flattened bench on the station-facing side with 3 pads.
function buildPort(body: SurfaceBody, dir: Vec3): void {
  body.portDir = dir;
  body.portRadius = rawSurfaceRadius(body, dir) + 2;
  // bench covers the pad cluster plus a skirt
  const clusterSpan = 420; // m across the port
  body.portFlatAngle = (clusterSpan + 500) / body.radius;
  // tangent basis for laying out the pads
  let t1 = vcross(dir, v3(0, 1, 0));
  if (vlen(t1) < 1e-6) t1 = vcross(dir, v3(1, 0, 0));
  t1 = vnorm(t1);
  const t2 = vnorm(vcross(dir, t1));
  const offsets: Array<[number, number]> = [[0, 0], [1, 0.2], [-0.6, 0.85]];
  offsets.forEach(([a, b], i) => {
    const padDir = vnorm(vadd(dir, vadd(vscale(t1, (a * 150) / body.radius), vscale(t2, (b * 150) / body.radius))));
    body.pads.push({
      id: `${body.id}_pad_${i + 1}`,
      name: `PAD ${i + 1}`,
      bodyId: body.id,
      pos: vadd(body.pos, vscale(padDir, body.portRadius)),
      up: padDir,
      radius: PAD_RADIUS,
    });
  });
}

// Terrain height without the port bench blend.
function rawSurfaceRadius(body: SurfaceBody, dirUnit: Vec3): number {
  if (!body.solid) return body.radius;
  const n = fbm3(dirUnit.x * NOISE_FREQ, dirUnit.y * NOISE_FREQ, dirUnit.z * NOISE_FREQ, body.seed, 4) - 0.5;
  let r = body.radius * (1 + RELIEF[body.kind] * 2 * n);
  if (body.kind === 'terran' && r < body.radius) r = body.radius; // sea level
  return r;
}

// Distance from body center to the surface along a direction — the single
// source of truth for terrain: sim collision and rendered mesh both sample it.
export function surfaceRadius(body: SurfaceBody, dirUnit: Vec3): number {
  const raw = rawSurfaceRadius(body, dirUnit);
  if (!body.portDir) return raw;
  // blend to the port bench so pads sit on flat ground
  const cosA = dirUnit.x * body.portDir.x + dirUnit.y * body.portDir.y + dirUnit.z * body.portDir.z;
  const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (ang >= body.portFlatAngle) return raw;
  const t = ang / body.portFlatAngle;          // 0 at port center, 1 at edge
  const s = t * t * (3 - 2 * t);
  const blend = s * s;                         // extra-flat around the pads
  return body.portRadius * (1 - blend) + raw * blend;
}

export interface SurfaceEnv {
  body: SurfaceBody;
  dist: number;      // from body center
  up: Vec3;          // radial unit
  surfR: number;     // terrain distance from center under the ship
  altitude: number;  // above terrain
  density: number;   // 0..1 atmosphere at this height (kind-scaled)
  gravity: number;   // m/s² toward the body
}

// Environment sample for a world position, or null when clear of all bodies.
export function surfaceEnvAt(bodies: SurfaceBody[], pos: Vec3): SurfaceEnv | null {
  for (const body of bodies) {
    const d = vdist(pos, body.pos);
    if (d > body.radius * GRAVITY_TOP_MULT) continue;
    const up = vnorm(vsub(pos, body.pos));
    const surfR = surfaceRadius(body, up);
    const x = d / body.radius;
    const atmoT = Math.max(0, Math.min(1, (ATMO_TOP_MULT - x) / (ATMO_TOP_MULT - 1)));
    const gravT = Math.max(0, Math.min(1, (GRAVITY_TOP_MULT - x) / (GRAVITY_TOP_MULT - 1)));
    return {
      body, dist: d, up, surfR,
      altitude: d - surfR,
      density: Math.pow(atmoT, 1.5) * ATMO_DENSITY[body.kind],
      gravity: SURFACE_G * gravT * (body.kind === 'gas' ? 1.4 : 1),
    };
  }
  return null;
}
