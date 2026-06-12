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

  toggle(): void {
    this.mode = this.mode === 'cockpit' ? 'chase' : 'cockpit';
    this.smoothing = null;
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
      const target = vadd(pos, qrot(orient, off));
      if (!this.smoothing) {
        this.smoothing = { pos: target, quat: orient };
      } else {
        const k = 1 - Math.exp(-dt * 7);
        this.smoothing.pos = vlerp(this.smoothing.pos, target, k);
        this.smoothing.quat = qnlerp(this.smoothing.quat, orient, k);
      }
      camPos = this.smoothing.pos;
      camQuat = this.smoothing.quat;
    }
    sm.setCamera(camPos, new THREE.Quaternion(camQuat.x, camQuat.y, camQuat.z, camQuat.w));
  }
}
