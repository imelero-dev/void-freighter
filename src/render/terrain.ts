// Near-scene planetary terrain patch (#16). The planet sphere lives in the far
// scene; once you drop close to the surface this lays a procedural ground patch
// in the near scene, centred under the ship and oriented to the local horizon,
// so you actually descend onto real terrain with relief — mountains, valleys,
// ridgelines, slope-shaded — not a flat plane. Cosmetic (collision is still the
// sphere, which is flat at planet scale); distance haze hides the patch edge.

import * as THREE from 'three';
import { fbm2 } from '../sim/rng';
import type { PlanetKind, SystemDef } from '../sim/types';
import { atmoHeight, atmosphereAt } from '../sim/system';
import type { SceneManager } from './scene';

const SIZE = 16000;    // patch span (m) — reaches well past the low-altitude horizon
const SEG = 84;        // grid resolution
const VISIBLE_ALT = 4200; // the patch fades in this high so the descent has relief, not a late pop

// base palette + how dramatic the relief is, per world kind
const GROUND: Record<PlanetKind, { lo: THREE.Color; hi: THREE.Color; rock: THREE.Color; amp: number; freq: number; ridged: boolean }> = {
  rocky:  { lo: new THREE.Color(0x4a4138), hi: new THREE.Color(0x9c8d76), rock: new THREE.Color(0x332c25), amp: 2200, freq: 1, ridged: true },
  terran: { lo: new THREE.Color(0x33502c), hi: new THREE.Color(0xa59a6d), rock: new THREE.Color(0x4b3f30), amp: 1900, freq: 0.95, ridged: true },
  barren: { lo: new THREE.Color(0x564f45), hi: new THREE.Color(0xa39a8a), rock: new THREE.Color(0x3a342c), amp: 2000, freq: 1.1, ridged: true },
  ice:    { lo: new THREE.Color(0x8fa6b4), hi: new THREE.Color(0xf2f9ff), rock: new THREE.Color(0x6b8290), amp: 1300, freq: 0.8, ridged: false },
  lava:   { lo: new THREE.Color(0x1c100c), hi: new THREE.Color(0xd6571c), rock: new THREE.Color(0x140a07), amp: 2100, freq: 1.2, ridged: true },
  gas:    { lo: new THREE.Color(0x53536a), hi: new THREE.Color(0x9a9ac0), rock: new THREE.Color(0x3c3c50), amp: 700, freq: 0.6, ridged: false },
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
  private tmpRock = new THREE.Color();

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

  // ridged/billowed multi-octave height in metres at a world tangent coordinate.
  // A low-frequency domain warp bends the ridgelines so they meander like real
  // mountain chains instead of gridded bumps; high octaves add rocky detail.
  private heightAt(u: number, v: number, seed: number, def: typeof GROUND[PlanetKind]): number {
    const f = 0.00011 * def.freq;
    // domain warp
    const wx = fbm2(u * f * 0.35 + 19, v * f * 0.35, seed + 711, 1) - 0.5;
    const wy = fbm2(u * f * 0.35, v * f * 0.35 - 23, seed + 913, 1) - 0.5;
    const uu = u + wx * 4200;
    const vv = v + wy * 4200;
    // large-scale highlands vs basins, so the patch isn't uniformly busy
    const cont = fbm2(uu * f * 0.45, vv * f * 0.45, seed + 41, 1); // 0..1
    let h = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < 6; o++) {
      let n = fbm2(uu * f * freq, vv * f * freq, seed + o * 131, 1); // 0..1
      if (def.ridged) n = 1 - Math.abs(n * 2 - 1); // sharp ridges -> mountains
      h += n * amp;
      norm += amp;
      amp *= 0.52;
      freq *= 2.15;
    }
    let hn = h / norm;
    if (def.ridged) hn = Math.pow(hn, 1.4); // bias toward valleys with sharp peaks
    return hn * def.amp * (0.45 + cont * 0.9);
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
    // pass 1: heights
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i);
      const u = wx + this.t1.x * lx + this.t2.x * ly;
      const vv = wz + this.t1.z * lx + this.t2.z * ly;
      const h = this.heightAt(u, vv, seed, def);
      // sink the patch edges so it tucks under the horizon haze, no hard rim
      const edge = Math.max(Math.abs(lx), Math.abs(ly)) / half;
      const fade = edge > 0.62 ? (edge - 0.62) / 0.38 : 0;
      pos.setZ(i, h - fade * fade * def.amp * 1.6);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    // pass 2: shade by height AND slope (steep faces show bare rock)
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getZ(i);
      const t = Math.min(1, Math.max(0, h / def.amp));
      this.tmpCol.copy(def.lo).lerp(def.hi, t * t);
      const slope = 1 - Math.min(1, Math.max(0, nor.getZ(i))); // 0 flat .. 1 cliff
      const rockMix = Math.min(1, slope * 1.8);
      this.tmpRock.copy(def.rock);
      this.tmpCol.lerp(this.tmpRock, rockMix * 0.8);
      col.setXYZ(i, this.tmpCol.r, this.tmpCol.g, this.tmpCol.b);
    }
    col.needsUpdate = true;
    // self-illumination rises as you get very low so a night-side landing isn't
    // pitch black, while high passes stay sunlit
    this.mat.emissiveIntensity = 0.16 + 0.28 * (1 - Math.min(1, atmo.altitude / atmoHeight(p)));
    this.mat.emissive.copy(def.lo).multiplyScalar(0.6);
    this.mesh.visible = true;
  }
}
