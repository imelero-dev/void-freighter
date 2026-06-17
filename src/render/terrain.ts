// Near-scene planetary terrain patch (#16). The planet sphere lives in the far
// scene; once you drop close to the surface this lays a procedural ground patch
// in the near scene, centred under the ship and oriented to the local horizon,
// so you actually descend onto terrain instead of a distant ball. Cosmetic —
// collision is still the sphere — but the surface is nearly flat at km scale so
// the patch sits right on it.

import * as THREE from 'three';
import { fbm2 } from '../sim/rng';
import type { PlanetKind, SystemDef } from '../sim/types';
import { atmosphereAt } from '../sim/system';
import type { SceneManager } from './scene';

const SIZE = 7000;     // patch span (m)
const SEG = 44;        // grid resolution
const VISIBLE_ALT = 4200; // show the patch below this altitude

const GROUND_COLOR: Record<PlanetKind, number> = {
  rocky: 0x6b6357, terran: 0x4f6a44, ice: 0x9fb8c4,
  lava: 0x3a2018, barren: 0x726a60, gas: 0x6a6a80,
};
const HEIGHT_AMP: Record<PlanetKind, number> = {
  rocky: 220, terran: 150, ice: 90, lava: 180, barren: 120, gas: 30,
};

export class TerrainPatch {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  private up = new THREE.Vector3();
  private t1 = new THREE.Vector3();
  private t2 = new THREE.Vector3();
  private basis = new THREE.Matrix4();
  private gp = new THREE.Vector3();

  constructor(private sm: SceneManager) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    // a faint self-illumination so the ground reads even on a planet's night
    // side, where the sun isn't lighting it
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x6b6357, roughness: 1, metalness: 0, flatShading: true,
      emissive: 0x6b6357, emissiveIntensity: 0.35,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    sm.near.add(this.mesh);
  }

  // shipPos: player world position; called every frame
  update(system: SystemDef, shipPos: { x: number; y: number; z: number }): void {
    const atmo = atmosphereAt(system, shipPos);
    if (!atmo.planet || atmo.altitude > VISIBLE_ALT) {
      this.mesh.visible = false;
      return;
    }
    const p = atmo.planet;
    // local horizon frame: up = away from planet centre, two tangents
    this.up.set(shipPos.x - p.pos.x, shipPos.y - p.pos.y, shipPos.z - p.pos.z).normalize();
    const ref = Math.abs(this.up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.t1.copy(ref).cross(this.up).normalize();
    this.t2.copy(this.up).cross(this.t1).normalize();
    // ground point: the planet surface directly under the ship, near-scene local
    this.gp.set(
      p.pos.x + this.up.x * p.radius - this.sm.origin.x,
      p.pos.y + this.up.y * p.radius - this.sm.origin.y,
      p.pos.z + this.up.z * p.radius - this.sm.origin.z,
    );
    this.basis.makeBasis(this.t1, this.t2, this.up);
    this.mesh.quaternion.setFromRotationMatrix(this.basis);
    this.mesh.position.copy(this.gp);

    // deform: sample noise by WORLD position so the bumps stay put as the patch
    // tracks the ship. Local plane is XY (normal +Z == up).
    const amp = HEIGHT_AMP[p.kind];
    const seed = p.colorSeed;
    const wx = p.pos.x + this.up.x * p.radius;
    const wy = p.pos.y + this.up.y * p.radius;
    const wz = p.pos.z + this.up.z * p.radius;
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i);
      // world coords of this vertex (ignoring height) for stable noise
      const vx = wx + this.t1.x * lx + this.t2.x * ly;
      const vz = wz + this.t1.z * lx + this.t2.z * ly;
      void wy;
      const h = (fbm2(vx * 0.00035, vz * 0.00035, seed, 4) - 0.5) * 2 * amp;
      pos.setZ(i, h);
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mat.color.setHex(GROUND_COLOR[p.kind]);
    this.mat.emissive.setHex(GROUND_COLOR[p.kind]);
    // fade the self-illumination up as you get very low so high passes still
    // look sunlit, but a night-side touchdown is never pitch black
    this.mat.emissiveIntensity = 0.25 + 0.35 * (1 - Math.min(1, atmo.altitude / VISIBLE_ALT));
    this.mesh.visible = true;
  }
}
