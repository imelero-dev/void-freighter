// Station docking geometry & readiness. A single pure module shared by the
// authoritative Sim (collision + the dock grant), the HUD approach aid and the
// renderer, so the instrument, the visible hangar and what actually docks you
// can never disagree.
//
// Every station is a big solid hull with one open HANGAR carved into the face
// its dock port points at. You fly in through the hatch, descend onto the
// interior landing pad in VTOL with the gear down, and set down gently — then
// you're docked. No external floating pads, no auto-suck: the skill is flying
// the approach and the touchdown.

import type { StationDef, SystemDef } from './types';
import { atmoHeight } from './system';
import { qForward, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type Quat, type Vec3 } from './vec';
import { DOCK_MAX_SPEED } from './data';

// The station hull is a chunky box in its own (u,v,f) frame — a Coriolis-style
// block — with a rectangular hangar "mail slot" cut into the +f (dock) face.
// All dimensions are fractions of the station hull radius R.
export const HULL_HX = 1.00;   // hull half-width  (along u)
export const HULL_HY = 0.78;   // hull half-height (along v)
export const HULL_HZ = 0.92;   // hull half-depth  (along f); dock face at +HZ
export const HANGAR_HALF_W = 0.42;   // hangar half width  (along u) — the slot
export const HANGAR_HALF_H = 0.26;   // hangar half height (along v)
export const HANGAR_DEPTH = 0.95;    // how deep the hangar cuts in (along -f)
export const PAD_RADIUS = 0.30;      // landing-pad radius
export const PAD_DEPTH_FRAC = 0.5;   // pad centre depth into the hangar (× DEPTH)

export interface DockResult {
  ok: boolean;        // conditions met — docking is granted
  level: 0 | 1 | 2;   // approach-aid light: red / amber / green
  cue: string;        // terse instruction for the HUD + ATC wave-off
}

// Orthonormal hangar frame in world space. `f` is the outward hatch normal
// (== dock port); `u` is the lateral (width) axis; `v` is the hangar's "up"
// (the pad sits on the -v floor). u/v are derived deterministically from f so
// the sim, the HUD and the renderer all agree on which way is up inside the bay.
export interface HangarFrame {
  center: Vec3; R: number;
  f: Vec3; u: Vec3; v: Vec3;
  HX: number; HY: number; HZ: number; // hull half-extents in (u,v,f)
  HW: number; HH: number; D: number;  // hangar slot half-w/half-h and depth
  mouthA: number; backA: number;      // along-f coords of the dock face and back wall
  padA: number; padR: number;         // pad centre depth & radius
  floorV: number;                     // v-coord of the pad floor
}

export function hangarFrame(st: StationDef): HangarFrame {
  const f = vnorm(st.dockPort);
  const ref: Vec3 = Math.abs(f.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = vnorm(vcross(ref, f));
  const v = vnorm(vcross(f, u));
  const R = st.radius;
  const HZ = R * HULL_HZ;
  const D = R * HANGAR_DEPTH;
  return {
    center: st.pos, R, f, u, v,
    HX: R * HULL_HX, HY: R * HULL_HY, HZ,
    HW: R * HANGAR_HALF_W, HH: R * HANGAR_HALF_H, D,
    mouthA: HZ, backA: HZ - D,
    padA: HZ - D * PAD_DEPTH_FRAC, padR: R * PAD_RADIUS,
    floorV: -R * HANGAR_HALF_H,
  };
}

// World point of the hatch mouth (the thing the HUD diamond marks and what you
// aim for on approach) and its outward normal.
export function stationPort(st: StationDef): { point: Vec3; dir: Vec3 } {
  const fr = hangarFrame(st);
  return { point: vadd(fr.center, vscale(fr.f, fr.mouthA)), dir: fr.f };
}

// World point a ship rests at on the pad (a touch above the floor so it sits
// unambiguously inside the hangar slot, not on its lower edge).
export function padPoint(st: StationDef): Vec3 {
  const fr = hangarFrame(st);
  const restV = fr.floorV + fr.R * 0.03;
  return vadd(vadd(fr.center, vscale(fr.f, fr.padA)), vscale(fr.v, restV));
}

export const DOCK_STILL_SPEED = 6; // m/s — "at rest" threshold before the menu opens

// Readiness to dock: you have to be inside the hangar, settled on the pad floor
// with the landing gear down, over the pad, and brought to a stop. No VTOL
// requirement — drop the gear, set it down, hold still. The dwell + "armed"
// logic (in the Sim) is what stops it snapping you in the instant you touch.
export function dockCheck(st: StationDef, pos: Vec3, vel: Vec3, gearDown: boolean): DockResult {
  const fr = hangarFrame(st);
  const rel = vsub(pos, fr.center);
  const a = vdot(rel, fr.f);
  const pu = vdot(rel, fr.u);
  const pv = vdot(rel, fr.v);
  const inFootprint = Math.abs(pu) < fr.HW && Math.abs(pv) < fr.HH;
  const inside = inFootprint && a < fr.mouthA && a > fr.backA;
  const speed = vlen(vel);
  const overPad = inside && Math.hypot(pu, a - fr.padA) < fr.padR;
  const settled = pv < fr.floorV + fr.R * 0.12;   // set down on the pad floor
  const stopped = speed < DOCK_STILL_SPEED;        // not drifting

  if (overPad && settled && stopped && gearDown) return { ok: true, level: 2, cue: 'SETTLED — DOCKING' };
  if (inside) {
    const cue = !gearDown ? 'GEAR DOWN TO SET DOWN'
      : !overPad ? 'CENTRE OVER THE PAD'
        : !settled ? 'SET DOWN ON THE PAD'
          : 'COME TO A STOP';
    return { ok: false, level: 1, cue };
  }
  // lined up in front of the open mouth, about to fly in
  if (inFootprint && a >= fr.mouthA && a < fr.mouthA + fr.R * 1.6) {
    return { ok: false, level: 1, cue: speed > DOCK_MAX_SPEED ? 'SLOW FOR THE HANGAR' : 'FLY INTO THE HANGAR' };
  }
  return { ok: false, level: 0, cue: 'LINE UP WITH THE HANGAR MOUTH' };
}

// True while the ship is within the hangar's interior volume (used to re-arm
// docking only after you've actually flown back out).
export function insideHangar(st: StationDef, pos: Vec3): boolean {
  const fr = hangarFrame(st);
  const rel = vsub(pos, fr.center);
  const a = vdot(rel, fr.f), pu = vdot(rel, fr.u), pv = vdot(rel, fr.v);
  return Math.abs(pu) < fr.HW && Math.abs(pv) < fr.HH && a < fr.mouthA && a > fr.backA;
}

// "Up" reference for VTOL flight at a world position: the hangar floor normal
// when close to a station, otherwise the local vertical of a nearby planet or
// moon. null in open space (the caller falls back to the ship's own up). Shared
// by the Sim and the online client's prediction so hover behaves identically.
export function vtolUpRef(system: SystemDef, pos: Vec3): Vec3 | null {
  let best: StationDef | null = null;
  let bestD = Infinity;
  for (const st of system.stations) {
    const d = vlen(vsub(pos, st.pos));
    if (d < st.dockRadius * 2.4 && d < bestD) { bestD = d; best = st; }
  }
  if (best) return hangarFrame(best).v;

  let up: Vec3 | null = null;
  let nearest = Infinity;
  for (const p of system.planets) {
    const d = vlen(vsub(pos, p.pos));
    const alt = d - p.radius;
    if (alt < atmoHeight(p) * 1.8 && alt < nearest) { nearest = alt; up = vnorm(vsub(pos, p.pos)); }
  }
  for (const m of system.moons) {
    const d = vlen(vsub(pos, m.pos));
    const alt = d - m.radius;
    if (alt < m.radius * 0.6 && alt < nearest) { nearest = alt; up = vnorm(vsub(pos, m.pos)); }
  }
  return up;
}

// Nose-forward alignment helper kept for callers that grade heading (HUD).
export function noseAlignment(orient: Quat, pos: Vec3, target: Vec3): number {
  return vdot(qForward(orient), vnorm(vsub(target, pos)));
}
