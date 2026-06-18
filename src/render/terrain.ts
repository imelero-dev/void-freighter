// Near-scene planetary terrain (#16) — a seamless atmospheric-entry surface.
//
// The planet is a textured sphere in the far scene. The instant you cross into
// the atmosphere this lays a curved ground cap in the near scene that reaches
// ALL THE WAY TO THE TRUE HORIZON, so it fully occludes the far sphere below the
// skyline — there is no seam, no floating plate, just one continuous world that
// drops to the horizon like the view from a re-entering capsule. It is level-of-
// detail: high up the cap is wide and coarse (cheap, hazed by distance); as you
// fall the cap shrinks and the same grid resolves ever-finer relief, so the
// ground "comes into focus" continuously from entry interface to touchdown.
//
// It samples the SAME heightfield as the sim's ground collision, so you land on
// exactly the terrain you see. Curvature uses the exact spherical drop so the
// rim sits on the real horizon at every altitude.

import * as THREE from 'three';
import type { PlanetKind, SystemDef } from '../sim/types';
import { atmoHeight, atmosphereAt } from '../sim/system';
import { heightField, TERRAIN } from '../sim/terrain';
import type { SceneManager } from './scene';

const SEG = 168;            // grid resolution (constant; the cap's span varies with altitude)
const MAX_SPAN_HALF = 260_000; // cap the reach so the near far-plane stays sane (m)
const REBUILD_MOVE = 50;   // re-noise after the ship moves this far laterally (m)
const REBUILD_SPAN = 0.05; // ...or after the LOD span changes this fraction

// base palette per world kind (the shape comes from sim/terrain TERRAIN)
const GROUND: Record<PlanetKind, { lo: THREE.Color; hi: THREE.Color; rock: THREE.Color }> = {
  rocky:  { lo: new THREE.Color(0x4a4138), hi: new THREE.Color(0x9c8d76), rock: new THREE.Color(0x332c25) },
  terran: { lo: new THREE.Color(0x33502c), hi: new THREE.Color(0xa59a6d), rock: new THREE.Color(0x4b3f30) },
  barren: { lo: new THREE.Color(0x564f45), hi: new THREE.Color(0xa39a8a), rock: new THREE.Color(0x3a342c) },
  ice:    { lo: new THREE.Color(0x8fa6b4), hi: new THREE.Color(0xf2f9ff), rock: new THREE.Color(0x6b8290) },
  lava:   { lo: new THREE.Color(0x1c100c), hi: new THREE.Color(0xd6571c), rock: new THREE.Color(0x140a07) },
  gas:    { lo: new THREE.Color(0x53536a), hi: new THREE.Color(0x9a9ac0), rock: new THREE.Color(0x3c3c50) },
};

// Mid ground tone per kind — the far sphere is tinted to this on the descended
// world so the brief cross-fade at the atmosphere interface has nothing to seam.
export const GROUND_MID: Record<PlanetKind, THREE.Color> = {
  rocky: new THREE.Color(0x6b5f4f), terran: new THREE.Color(0x5e6b42), barren: new THREE.Color(0x756c5e),
  ice: new THREE.Color(0xbcced8), lava: new THREE.Color(0x5a2414), gas: new THREE.Color(0x73738f),
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
  private lastSpan = 0;
  private lastPlanet = '';
  private baseXY: Float32Array; // immutable unit grid (the position attr is overwritten with metres)

  // exposed so the renderer can fit the near far-plane and blend the far sphere
  active = false;
  reach = 0;        // distance to the cap's rim (m) — the near far-plane must clear it
  blend = 0;        // 0..1 how fully the near ground has taken over from the far sphere
  planetId = '';

  constructor(private sm: SceneManager) {
    // unit grid in [-0.5, 0.5]; rebuild() scales it to the current span
    const geo = new THREE.PlaneGeometry(1, 1, SEG, SEG);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
    const bp = geo.attributes.position as THREE.BufferAttribute;
    this.baseXY = new Float32Array(bp.count * 2);
    for (let i = 0; i < bp.count; i++) { this.baseXY[i * 2] = bp.getX(i); this.baseXY[i * 2 + 1] = bp.getY(i); }
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0, flatShading: true,
      emissive: 0x202020, emissiveIntensity: 0.25,
      transparent: true, opacity: 1, depthWrite: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.renderOrder = -10; // under near-scene ships/fx
    sm.near.add(this.mesh);
  }

  update(system: SystemDef, shipPos: { x: number; y: number; z: number }): void {
    const atmo = atmosphereAt(system, shipPos);
    const p = atmo.planet;
    if (!p || atmo.altitude > atmoHeight(p)) {
      this.mesh.visible = false; this.active = false; this.blend = 0; this.reach = 0;
      return;
    }
    const R = p.radius;
    const shell = atmoHeight(p);
    const alt = Math.max(20, atmo.altitude);

    // --- cap span is ALTITUDE-driven, not haze-driven. The cap stays just big
    //     enough that its grid keeps fine quads near the ship (so hills hold real
    //     relief and you can read where to set down), scaling up with altitude.
    //     Whatever lies past the rim is swallowed by haze and the ground-tinted
    //     far sphere, so the rim never reads as an edge. Capped by the true
    //     horizon (no point drawing ground that's over the curve) and a hard max
    //     that keeps the near far-plane sane. ---
    const cosH = R / (R + alt);
    const horizonPlanar = R * Math.sqrt(Math.max(0, 1 - cosH * cosH));
    const detailReach = alt * 2.2 + 7_000; // ~3x altitude: a readable landing bowl
    const spanHalf = Math.min(MAX_SPAN_HALF, horizonPlanar * 1.04, detailReach);
    const span = spanHalf * 2;

    // local horizon frame, centred on the sub-ship point on the sphere
    this.up.set(shipPos.x - p.pos.x, shipPos.y - p.pos.y, shipPos.z - p.pos.z).normalize();
    const ref = Math.abs(this.up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.t1.copy(ref).cross(this.up).normalize();
    this.t2.copy(this.up).cross(this.t1).normalize();
    this.gp.set(
      p.pos.x + this.up.x * R - this.sm.origin.x,
      p.pos.y + this.up.y * R - this.sm.origin.y,
      p.pos.z + this.up.z * R - this.sm.origin.z,
    );
    this.basis.makeBasis(this.t1, this.t2, this.up);
    this.mesh.quaternion.setFromRotationMatrix(this.basis);
    this.mesh.position.copy(this.gp);

    // re-noise only when the ship moved laterally or the LOD span changed
    const wx = p.pos.x + this.up.x * R;
    const wy = p.pos.y + this.up.y * R;
    const wz = p.pos.z + this.up.z * R;
    const moved = Math.hypot(wx - this.lastBuild.x, wy - this.lastBuild.y, wz - this.lastBuild.z);
    const spanChanged = Math.abs(span - this.lastSpan) > this.lastSpan * REBUILD_SPAN;
    if (moved > REBUILD_MOVE || spanChanged || this.lastPlanet !== p.id) {
      this.lastBuild.set(wx, wy, wz);
      this.lastSpan = span;
      this.lastPlanet = p.id;
      this.rebuild(p, wx, wz, spanHalf);
    }

    // distance from camera (the ship) to the rim, so the near far-plane fits it
    const dropRim = R - Math.sqrt(Math.max(0, R * R - spanHalf * spanHalf));
    this.reach = Math.hypot(spanHalf, alt + dropRim) + 4_000;

    // cross-fade in over the top slice of the shell so entry is soft, not a pop
    const fade = Math.min(1, (shell - atmo.altitude) / (shell * 0.45));
    this.mat.opacity = Math.max(0, fade);
    this.blend = fade;
    // a gentle floor-glow so the ground never goes pure black on the night side,
    // but kept LOW so the directional sun keeps its light-and-shadow — that
    // contrast across slopes is what lets you read hills and pick a landing spot
    // from altitude instead of seeing a flat washed plate.
    const deep = 1 - Math.min(1, atmo.altitude / shell);
    this.mat.emissiveIntensity = 0.08 + 0.22 * deep;
    this.mat.emissive.copy(GROUND[p.kind].lo).multiplyScalar(0.6);
    this.mesh.visible = true;
    this.active = true;
    this.planetId = p.id;
  }

  private rebuild(p: { kind: PlanetKind; colorSeed: number; radius: number }, wx: number, wz: number, spanHalf: number): void {
    const def = GROUND[p.kind];
    const prm = TERRAIN[p.kind];
    const seed = p.colorSeed;
    const R = p.radius;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const span = spanHalf * 2;
    // relief flattens at coarse (high) LOD so a wide cap isn't a spiky aliased
    // mess; it sharpens back to full strength as the cap tightens near the ground.
    // Generous, so hills keep their form (and their light/shadow) from altitude —
    // that's what lets you actually read where to set down on the way down.
    const reliefScale = Math.min(1, 50_000 / span);
    // pass 1: heights. grid is unit [-0.5,0.5]; scale by span here so one mesh
    // serves every LOD level. Curvature is the EXACT spherical drop so the rim
    // lands on the real horizon.
    for (let i = 0; i < pos.count; i++) {
      const lx = this.baseXY[i * 2] * span, ly = this.baseXY[i * 2 + 1] * span;
      const u = wx + this.t1.x * lx + this.t2.x * ly;
      const vv = wz + this.t1.z * lx + this.t2.z * ly;
      const s2 = lx * lx + ly * ly;
      // taper relief to flat near the rim so the cap meets the horizon cleanly
      const edge = Math.sqrt(s2) / spanHalf;
      const taper = edge < 0.82 ? 1 : Math.max(0, 1 - (edge - 0.82) / 0.18);
      const h = heightField(u, vv, seed, prm) * taper * reliefScale;
      const drop = R - Math.sqrt(Math.max(0, R * R - s2)); // exact sphere curvature
      pos.setXYZ(i, lx, ly, h - drop);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    // pass 2: shade by relief height AND slope (steep faces show bare rock)
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i);
      const s2 = lx * lx + ly * ly;
      const drop = R - Math.sqrt(Math.max(0, R * R - s2));
      const h = (pos.getZ(i) + drop) / Math.max(0.01, reliefScale);
      const t = Math.min(1, Math.max(0, h / prm.amp));
      // lowland -> highland with a brighter, snappier high so ridges and valleys
      // separate visibly from altitude (lit peaks vs shadowed lows = readable form)
      this.tmpCol.copy(def.lo).lerp(def.hi, Math.pow(t, 0.7));
      const slope = 1 - Math.min(1, Math.max(0, nor.getZ(i)));
      this.tmpCol.lerp(def.rock, Math.min(1, slope * 2.0) * 0.85);
      col.setXYZ(i, this.tmpCol.r, this.tmpCol.g, this.tmpCol.b);
    }
    col.needsUpdate = true;
    geo.computeBoundingSphere();
  }
}
