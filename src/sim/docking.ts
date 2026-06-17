// Multi-type docking geometry & readiness (#17). A single pure check shared by
// the authoritative Sim and the HUD approach aid so the instrument can never
// disagree with what actually docks you.
//
// Each station exposes a dock feature on its hull at `pos + dockPort*radius`:
//  - clamp: nose up to the external collar, lined up and slow → it locks.
//  - bay:   fly through the open mouth and come to rest inside (walls solid).
//  - pad:   set down on the exterior pad in VTOL with gear, gently and level.

import type { StationDef } from './types';
import { qForward, vdot, vlen, vnorm, vsub, type Quat, type Vec3 } from './vec';
import { DOCK_ALIGN, DOCK_MAX_SPEED } from './data';
import { SOFT_LAND_SPEED } from './system';

export const BAY_MOUTH_FRAC = 0.34;  // bay mouth radius / station radius
export const BAY_DEPTH_FRAC = 0.62;  // how deep the bay cuts into the hull
export const PAD_RADIUS_FRAC = 0.5;  // landing-pad radius / station radius

export interface DockResult {
  ok: boolean;        // conditions met — docking is granted
  level: 0 | 1 | 2;   // approach-aid light: red / amber / green
  cue: string;        // terse instruction for the HUD + ATC wave-off
}

// The dock feature's anchor point and outward normal in world space.
export function stationPort(st: StationDef): { point: Vec3; dir: Vec3 } {
  return {
    point: { x: st.pos.x + st.dockPort.x * st.radius, y: st.pos.y + st.dockPort.y * st.radius, z: st.pos.z + st.dockPort.z * st.radius },
    dir: st.dockPort,
  };
}

export function dockCheck(st: StationDef, pos: Vec3, vel: Vec3, orient: Quat, gearDown: boolean, vtol: boolean): DockResult {
  const rel = vsub(pos, st.pos);
  const along = vdot(rel, st.dockPort);                 // distance along the port axis
  const px = rel.x - st.dockPort.x * along;
  const py = rel.y - st.dockPort.y * along;
  const pz = rel.z - st.dockPort.z * along;
  const lateral = Math.hypot(px, py, pz);               // offset from the port axis
  const speed = vlen(vel);
  const slow = speed <= DOCK_MAX_SPEED;
  const noseAlign = vdot(qForward(orient), vnorm(vsub(st.pos, pos))); // nose toward the station
  const closing = vdot(vel, st.dockPort);               // +out / -in along the axis
  const r = st.radius;

  switch (st.dockType) {
    case 'clamp': {
      const onAxis = lateral < r * 0.45 && along > r * 0.5;
      const aligned = noseAlign > DOCK_ALIGN;
      if (onAxis && aligned && slow && along < r * 1.8) return { ok: true, level: 2, cue: 'CLAMP LOCK' };
      if (along < r * 2.4 && lateral < r * 0.9) return { ok: false, level: 1, cue: !slow ? 'REDUCE SPEED' : !aligned ? 'NOSE ON COLLAR' : 'CENTRE ON COLLAR' };
      return { ok: false, level: 0, cue: 'LINE UP ON THE CLAMP' };
    }
    case 'bay': {
      const inMouth = lateral < r * BAY_MOUTH_FRAC && along > 0;
      const inside = inMouth && along < r * 0.98 && along > r * (1 - BAY_DEPTH_FRAC);
      if (inside && slow) return { ok: true, level: 2, cue: 'IN THE BAY' };
      if (inMouth || (lateral < r * 0.7 && along > r * 0.7)) return { ok: false, level: 1, cue: !slow ? 'SLOW FOR THE BAY' : 'FLY INTO THE BAY' };
      return { ok: false, level: 0, cue: 'ALIGN WITH THE BAY MOUTH' };
    }
    case 'pad': {
      const overPad = lateral < r * PAD_RADIUS_FRAC && Math.abs(along - r) < r * 0.3;
      const gentle = Math.abs(closing) < SOFT_LAND_SPEED && slow;
      const ready = gearDown && vtol;
      if (overPad && gentle && ready) return { ok: true, level: 2, cue: 'SET DOWN' };
      if (lateral < r * 0.85 && Math.abs(along - r) < r * 0.6) return { ok: false, level: 1, cue: !ready ? 'VTOL + GEAR FOR PAD' : !gentle ? 'EASE YOUR DESCENT' : 'CENTRE ON THE PAD' };
      return { ok: false, level: 0, cue: 'LINE UP OVER THE PAD' };
    }
    default:
      return { ok: false, level: 0, cue: '' };
  }
}
