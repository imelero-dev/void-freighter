// Space dust: a small cloud of points wrapped around the camera. Sells speed
// and parallax in the empty void; denser inside asteroid fields.

import * as THREE from 'three';
import type { IWorld } from '../world_api';
import { vdist } from '../sim/vec';
import type { SceneManager } from './scene';

const COUNT = 420;
const RADIUS = 520; // m around the camera

export class DustLayer {
  private points: THREE.Points;
  private mat: THREE.PointsMaterial;
  private offsets: Float32Array; // fixed world-mod-space offsets

  constructor(private sm: SceneManager, private world: IWorld) {
    this.offsets = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT * 3; i++) this.offsets[i] = Math.random() * RADIUS * 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    this.mat = new THREE.PointsMaterial({
      color: 0x99948a, size: 1.1, sizeAttenuation: true,
      transparent: true, opacity: 0.0, depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    sm.near.add(this.points);
  }

  update(): void {
    const ship = this.world.player;
    if (!ship || ship.dockedAt) {
      this.mat.opacity = 0;
      return;
    }
    const o = this.sm.origin;
    // dust wraps in a repeating lattice around the camera (mod-space)
    const pos = this.points.geometry.attributes.position as THREE.BufferAttribute;
    const span = RADIUS * 2;
    for (let i = 0; i < COUNT; i++) {
      const wx = this.offsets[i * 3];
      const wy = this.offsets[i * 3 + 1];
      const wz = this.offsets[i * 3 + 2];
      pos.setXYZ(
        i,
        ((wx - o.x) % span + span * 1.5) % span - RADIUS,
        ((wy - o.y) % span + span * 1.5) % span - RADIUS,
        ((wz - o.z) % span + span * 1.5) % span - RADIUS,
      );
    }
    pos.needsUpdate = true;
    // visible when moving; denser inside belt fields; gone at full cruise
    // (you outrun the dust — and rendering it at 200 km/s is just noise)
    const speed = Math.hypot(ship.vel.x, ship.vel.y, ship.vel.z);
    let inField = false;
    for (const belt of this.world.system.belts) {
      for (const f of belt.fields) {
        if (vdist(ship.pos, f.pos) < f.radius * 1.4) {
          inField = true;
          break;
        }
      }
      if (inField) break;
    }
    const speedFade = speed > 3000 ? Math.max(0, 1 - (speed - 3000) / 5000) : Math.min(1, speed / 60 + 0.25);
    this.mat.opacity = (inField ? 0.5 : 0.22) * speedFade;
  }
}
