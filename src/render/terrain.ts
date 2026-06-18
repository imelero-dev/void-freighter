// Near-scene planetary terrain patch (#16). The planet sphere lives in the far
// scene; once you drop close to the surface this lays a procedural ground patch
// in the near scene, centred under the ship and oriented to the local horizon.
// It uses the SAME heightfield as the sim's ground collision, so you land on the
// terrain you see. The patch follows the planet's curvature so it reads as solid
// ground dropping to a clean horizon — not flat plates floating in the sky.

import * as THREE from 'three';
import type { PlanetKind, SystemDef } from '../sim/types';
import { atmoHeight, atmosphereAt } from '../sim/system';
import { heightField, TERRAIN } from '../sim/terrain';
import type { SceneManager } from './scene';

const SIZE = 26000;    // patch span (m) — reaches to the low-altitude horizon
const SEG = 96;        // grid resolution
const VISIBLE_ALT = 5000; // fade the patch in this high so the descent has relief
const REBUILD_MOVE = 35;  // only re-noise the mesh after the ship moves this far

// base palette per world kind (the shape comes from sim/terrain TERRAIN)
const GROUND: Record<PlanetKind, { lo: THREE.Color; hi: THREE.Color; rock: THREE.Color }> = {
  rocky:  { lo: new THREE.Color(0x4a4138), hi: new THREE.Color(0x9c8d76), rock: new THREE.Color(0x332c25) },
  terran: { lo: new THREE.Color(0x33502c), hi: new THREE.Color(0xa59a6d), rock: new THREE.Color(0x4b3f30) },
  barren: { lo: new THREE.Color(0x564f45), hi: new THREE.Color(0xa39a8a), rock: new THREE.Color(0x3a342c) },
  ice:    { lo: new THREE.Color(0x8fa6b4), hi: new THREE.Color(0xf2f9ff), rock: new THREE.Color(0x6b8290) },
  lava:   { lo: new THREE.Color(0x1c100c), hi: new THREE.Color(0xd6571c), rock: new THREE.Color(0x140a07) },
  gas:    { lo: new THREE.Color(0x53536a), hi: new THREE.Color(0x9a9ac0), rock: new THREE.Color(0x3c3c50) },
};

export class TerrainPatch {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  private up = new THREE.Vector3();
  private t1 = new THREE.Vector3();
  private t2 = new THREE.Vector3();
  private basis = new THREE.Matrix4();
  private gp = new THREE.Vector3();
  private tmpCol = new THREE.Color();
  private lastBuild = new THREE.Vector3(Infinity, 0, 0);
  private lastPlanet = '';

  constructor(private sm: SceneManager) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0, flatShading: true,
      emissive: 0x202020, emissiveIntensity: 0.25,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    sm.near.add(this.mesh);
  }

  update(system: SystemDef, shipPos: { x: number; y: number; z: number }): void {
    const atmo = atmosphereAt(system, shipPos);
    if (!atmo.planet || atmo.altitude > VISIBLE_ALT) {
      this.mesh.visible = false;
      return;
    }
    const p = atmo.planet;
    // local horizon frame, centred on the sub-ship point on the sphere
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

    // only re-noise the heightfield when the ship has actually moved — the patch
    // is world-locked, so a hovering ship keeps a stable, cheap-to-hold mesh
    const wx = p.pos.x + this.up.x * p.radius;
    const wy = p.pos.y + this.up.y * p.radius;
    const wz = p.pos.z + this.up.z * p.radius;
    const moved = Math.hypot(wx - this.lastBuild.x, wy - this.lastBuild.y, wz - this.lastBuild.z);
    if (moved > REBUILD_MOVE || this.lastPlanet !== p.id) {
      this.lastBuild.set(wx, wy, wz);
      this.lastPlanet = p.id;
      this.rebuild(p, wx, wz);
    }

    this.mat.emissiveIntensity = 0.16 + 0.28 * (1 - Math.min(1, atmo.altitude / atmoHeight(p)));
    this.mat.emissive.copy(GROUND[p.kind].lo).multiplyScalar(0.6);
    this.mesh.visible = true;
  }

  private rebuild(p: { kind: PlanetKind; colorSeed: number; radius: number }, wx: number, wz: number): void {
    const def = GROUND[p.kind];
    const prm = TERRAIN[p.kind];
    const seed = p.colorSeed;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const half = SIZE * 0.5;
    const invCurve = 1 / (2 * p.radius); // planet curvature → the ground drops away
    // pass 1: heights (relief on top of the curved cap)
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i);
      const u = wx + this.t1.x * lx + this.t2.x * ly;
      const vv = wz + this.t1.z * lx + this.t2.z * ly;
      // taper the relief to flat near the rim so the cap meets the far sphere
      const edge = Math.max(Math.abs(lx), Math.abs(ly)) / half;
      const taper = edge < 0.8 ? 1 : Math.max(0, 1 - (edge - 0.8) / 0.2);
      const h = heightField(u, vv, seed, prm) * taper;
      const drop = (lx * lx + ly * ly) * invCurve; // curve the cap down to the horizon
      pos.setZ(i, h - drop);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    // pass 2: shade by height AND slope (steep faces show bare rock)
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i);
      const drop = (lx * lx + ly * ly) * invCurve;
      const h = pos.getZ(i) + drop; // relief height above the cap
      const t = Math.min(1, Math.max(0, h / prm.amp));
      this.tmpCol.copy(def.lo).lerp(def.hi, t * t);
      const slope = 1 - Math.min(1, Math.max(0, nor.getZ(i)));
      this.tmpCol.lerp(def.rock, Math.min(1, slope * 1.8) * 0.8);
      col.setXYZ(i, this.tmpCol.r, this.tmpCol.g, this.tmpCol.b);
    }
    col.needsUpdate = true;
  }
}
