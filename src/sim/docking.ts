// Docking geometry & thresholds (#17/#18/#20), shared by sim collision,
// ATC logic, the approach-radar HUD and the station renderer. No DOM.

import type { ApproachState, StationDef, SystemDef } from './types';
import type { SurfaceBody } from './surface';
import { v3, vadd, vcross, vlen, vnorm, vscale, type Vec3 } from './vec';

// hangar bay: a rectangular tunnel bored along bayDir, mouth just proud of
// the keep-out sphere, dock floor deep inside
export const BAY_HALF_W = 60;
export const BAY_HALF_H = 42;
export const BAY_MOUTH_MULT = 1.06;   // × station radius
export const BAY_FLOOR_MULT = 0.34;   // × station radius
export const BAY_DOCK_SPEED = 18;     // m/s at the floor to be granted dock

// external clamp collar
export const CLAMP_COLLAR_MULT = 1.05;
export const CLAMP_CAPTURE_RADIUS = 30;
export const CLAMP_MAX_SPEED = 8;
export const CLAMP_ALIGN_COS = 0.94;  // nose within ~20° of the collar axis
export const CLAMP_HOLD_S = 1.5;

// landing pads / surface touchdown
export const PAD_MAX_VSPEED = 9;      // m/s sink rate with gear down
export const PAD_MAX_LATERAL = 14;    // m/s ground speed at touchdown
export const GEAR_DEPLOY_S = 1.6;

export const APPROACH_RANGE_STATION = 7000;   // request clearance within this
export const AUTODOCK_PRICE = 500;            // cr — the lazy tax (#17)

// station-local basis for the bay tunnel
export function bayFrame(st: StationDef): { axis: Vec3; lat: Vec3; up: Vec3 } {
  const axis = st.bayDir; // outward, equatorial (y = 0 by construction)
  let lat = vcross(axis, v3(0, 1, 0));
  if (vlen(lat) < 1e-6) lat = vcross(axis, v3(1, 0, 0));
  lat = vnorm(lat);
  const up = vnorm(vcross(lat, axis));
  return { axis, lat, up };
}

export function bayMouthPos(st: StationDef): Vec3 {
  return vadd(st.pos, vscale(st.bayDir, st.radius * BAY_MOUTH_MULT));
}

export function clampCollarPos(st: StationDef): Vec3 {
  return vadd(st.pos, vscale(st.clampDir, st.radius * CLAMP_COLLAR_MULT));
}

// Where the approach radar should steer the pilot for the assigned slot.
export function approachTarget(
  system: SystemDef,
  bodies: SurfaceBody[],
  appr: ApproachState,
): { pos: Vec3; inDir: Vec3 } | null {
  if (appr.targetKind === 'station') {
    const st = system.stations.find((s) => s.id === appr.targetId);
    if (!st) return null;
    if (appr.slot === 'clamp') {
      return { pos: clampCollarPos(st), inDir: vscale(st.clampDir, -1) };
    }
    return { pos: bayMouthPos(st), inDir: vscale(st.bayDir, -1) };
  }
  const body = bodies.find((b) => b.id === appr.targetId);
  const pad = body?.pads.find((p) => p.id === appr.slot);
  if (!body || !pad) return null;
  return { pos: pad.pos, inDir: vscale(pad.up, -1) };
}
