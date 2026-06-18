// Near-scene planetary terrain patch (#16). The planet sphere lives in the far
// scene; once you drop close to the surface this lays a procedural ground patch
// in the near scene, centred under the ship and oriented to the local horizon,
// so you actually descend onto real terrain with relief — mountains, valleys,
// height-shaded — not a flat plane. Cosmetic (collision is still the sphere,
// which is flat at planet scale); distance haze hides the patch edge.

import * as THREE from 'three';
import { fbm2 } from '../sim/rng';
import type { PlanetKind, SystemDef } from '../sim/types';
import { atmoHeight, atmosphereAt } from '../sim/system';
import type { SceneManager } from './scene';

const SIZE = 13000;    // patch span (m) — reaches past the low-altitude horizon
const SEG = 72;        // grid resolution
const VISIBLE_ALT = 2200; // near patch adds touchdown detail; the far planet has its own relief for the descent

// base palette + how dramatic the relief is, per world kind
const GROUND: Record<PlanetKind, { lo: THREE.Color; hi: THREE.Color; amp: number; freq: number; ridged: boolean }> = {
  rocky:  { lo: new THREE.Color(0x4a4138), hi: new THREE.Color(0x8a7d6a), amp: 1500, freq: 1, ridged: true },
  terran: { lo: new THREE.Color(0x2e4a2a), hi: new THREE.Color(0x9a8d63), amp: 1100, freq: 0.9, ridged: true },
  barren: { lo: new THREE.Color(0x564f45), hi: new THREE.Color(0x938a7c), amp: 1300, freq: 1.1, ridged: true },
  ice:    { lo: new THREE.Color(0x8fa6b4), hi: new THREE.Color(0xeaf4fb), amp: 800, freq: 0.8, ridged: false },
  lava:   { lo: new THREE.Color(0x1c100c), hi: new THREE.Color(0xc24a18), amp: 1400, freq: 1.2, ridged: true },
  gas:    { lo: new THREE.Color(0x53536a), hi: new THREE.Color(0x9a9ac0), amp: 400, freq: 0.6, ridged: false },
};

export class TerrainPatch {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  private up = new THREE.Vector3();
  private t1 = new THREE.Vector3();
  private t2 = new THREE.Vector3();
  private basis = new THREE.Matrix4();
  private gp = new THREE.Vector3();
  private colors: Float32Array;
  private tmpCol = new THREE.Color();

  constructor(private sm: SceneManager) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    this.colors = new Float32Array(geo.attributes.position.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0, flatShading: true,
      emissive: 0x202020, emissiveIntensity: 0.25,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    sm.near.add(this.mesh);
  }

  // ridged/billowed multi-octave height in metres at a world tangent coordinate
  private heightAt(u: number, v: number, seed: number, def: typeof GROUND[PlanetKind]): number {
    const f = 0.00009 * def.freq;
    let h = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < 5; o++) {
      let n = fbm2(u * f * freq, v * f * freq, seed + o * 131, 1); // 0..1
      if (def.ridged) n = 1 - Math.abs(n * 2 - 1); // sharp ridges -> mountains
      h += n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return (h / norm) * def.amp;
  }

  // shipPos: player world position; called every frame
  update(system: SystemDef, shipPos: { x: number; y: number; z: number }): void {
    const atmo = atmosphereAt(system, shipPos);
    if (!atmo.planet || atmo.altitude > VISIBLE_ALT) {
      this.mesh.visible = false;
      return;
    }
    const p = atmo.planet;
    const def = GROUND[p.kind];
    // local horizon frame
    this.up.set(shipPos.x - p.pos.x, shipPos.y - p.pos.y, shipPos.z - p.pos.z).normalize();
    const ref = Math.abs(this.up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.t1.copy(ref).cross(this.up).normalize();
    this.t2.copy(this.up).cross(this.t1).normalize();
    this.gp.set(
      p.pos.x + this.up.x * p.radius - this.sm.origin.x,
      p.pos.y + this.up.y * p.radius - this.sm.origin.y,
      p.pos.z + this.up.z * p.radius - this.sm.origin.z,
    );
    this.basis.makeBasis(this.t1, this.t2, this.up);
    this.mesh.quaternion.setFromRotationMatrix(this.basis);
    this.mesh.position.copy(this.gp);

    const seed = p.colorSeed;
    const wx = p.pos.x + this.up.x * p.radius;
    const wz = p.pos.z + this.up.z * p.radius;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const half = SIZE * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i);
      // world tangent coords for stable noise as the patch tracks the ship
      const u = wx + this.t1.x * lx + this.t2.x * ly;
      const vv = wz + this.t1.z * lx + this.t2.z * ly;
      const h = this.heightAt(u, vv, seed, def);
      // sink the patch edges so it tucks under the horizon haze, no hard rim
      const edge = Math.max(Math.abs(lx), Math.abs(ly)) / half;
      const fade = edge > 0.7 ? (edge - 0.7) / 0.3 : 0;
      pos.setZ(i, h - fade * fade * def.amp * 1.4);
      // height shading + slope-ish variation
      const t = Math.min(1, h / def.amp);
      this.tmpCol.copy(def.lo).lerp(def.hi, t * t);
      col.setXYZ(i, this.tmpCol.r, this.tmpCol.g, this.tmpCol.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
    // self-illumination rises as you get very low so a night-side landing isn't
    // pitch black, while high passes stay sunlit
    this.mat.emissiveIntensity = 0.18 + 0.3 * (1 - Math.min(1, atmo.altitude / atmoHeight(p)));
    this.mat.emissive.copy(def.lo).multiplyScalar(0.6);
    this.mesh.visible = true;
  }
}
