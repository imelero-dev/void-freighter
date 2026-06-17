// Cockpit (canonical) and chase camera. The camera's world position is the
// scene's floating origin.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { qnlerp, qrot, vadd, vlerp, vscale, type Quat, type Vec3 } from '../sim/vec';
import type { SceneManager } from '../render/scene';

const CHASE_OFFSETS: Record<string, Vec3> = {
  shuttle: { x: 0, y: 7, z: 22 },
  hauler: { x: 0, y: 11, z: 38 },
  prospector: { x: 0, y: 9, z: 28 },
  interceptor: { x: 0, y: 7, z: 26 },
  freighter: { x: 0, y: 16, z: 62 },
  pirate: { x: 0, y: 7, z: 24 },
};

const COCKPIT_OFFSETS: Record<string, Vec3> = {
  shuttle: { x: 0, y: 1.6, z: -3.2 },
  hauler: { x: 0, y: 1.4, z: -11.6 },
  prospector: { x: 0, y: 0.8, z: -4.4 },
  interceptor: { x: 0, y: 1.2, z: -2.2 },
  freighter: { x: 0, y: 3.4, z: -19 },
  pirate: { x: 0, y: 1, z: -2 },
};

export class CameraRig {
  mode: 'cockpit' | 'chase' = 'cockpit';
  private smoothing: { pos: Vec3; quat: Quat } | null = null;
  private recoil = 0; // transient weapon-fire screen kick, decays fast

  toggle(): void {
    this.mode = this.mode === 'cockpit' ? 'chase' : 'cockpit';
    this.smoothing = null;
  }

  // brief camera punch when the player fires — gives shots weight (#12)
  kick(mag = 1): void {
    this.recoil = Math.min(1.5, this.recoil + mag);
  }

  // Computes camera world pos + orientation from the (interpolated) ship state.
  apply(sm: SceneManager, ship: Entity, alpha: number, dt: number): void {
    const pos = vlerp(ship.prevPos, ship.pos, alpha);
    const orient = qnlerp(ship.prevOrient, ship.orient, alpha);
    let camPos: Vec3;
    let camQuat: Quat;
    if (this.mode === 'cockpit') {
      const off = { ...(COCKPIT_OFFSETS[ship.hullId] ?? COCKPIT_OFFSETS.shuttle) };
      // engine rumble: subtle cockpit shake scaling with throttle/cruise
      if (!ship.dockedAt) {
        const shake = ship.cruise === 'cruise' ? 0.1 : Math.abs(ship.throttle) * 0.07;
        off.x += (Math.random() - 0.5) * shake;
        off.y += (Math.random() - 0.5) * shake;
      }
      camPos = vadd(pos, qrot(orient, off));
      camQuat = orient;
      this.smoothing = null;
    } else {
      const off = CHASE_OFFSETS[ship.hullId] ?? CHASE_OFFSETS.shuttle;
      if (!this.smoothing) {
        this.smoothing = { pos: pos, quat: orient };
      } else {
        // orientation eases for a cinematic feel; position is RIGID relative
        // to the ship — positional lag at cruise/turbo speeds (km per frame)
        // would leave the ship a dot on the horizon
        const k = 1 - Math.exp(-dt * 7);
        this.smoothing.quat = qnlerp(this.smoothing.quat, orient, k);
      }
      camQuat = this.smoothing.quat;
      camPos = vadd(pos, qrot(camQuat, off));
    }
    // weapon recoil: a small, fast-decaying back-and-jitter kick in camera space
    if (this.recoil > 0) {
      const j = this.recoil;
      camPos = vadd(camPos, qrot(camQuat, {
        x: (Math.random() - 0.5) * 0.14 * j,
        y: (Math.random() - 0.5) * 0.1 * j,
        z: 0.09 * j,
      }));
      this.recoil = Math.max(0, this.recoil - dt * 9);
    }
    sm.setCamera(camPos, new THREE.Quaternion(camQuat.x, camQuat.y, camQuat.z, camQuat.w));
  }
}
