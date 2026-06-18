// Near-scene planetary terrain (#16) — a seamless atmospheric-entry surface.
//
// The planet is a textured sphere in the far scene. The instant you cross into
// the atmosphere this lays curved ground in the near scene that reaches the TRUE
// HORIZON, so it fully occludes the far sphere below the skyline — no seam, no
// floating plate, just one continuous world dropping to the horizon like the
// view from a re-entering capsule.
//
// TWO RESOLUTIONS (clipmap-lite) so detail is readable on the way down:
//   - a COARSE cap, sized to ~3x your altitude (capped by the horizon), that
//     carries the distant ground and the skyline;
//   - a FINE inner patch right under the ship with small quads, so hills hold
//     real relief from altitude and you can read where to set down — the detail
//     you used to only get at 1-2 km now starts up at ~10 km.
// Both sample the SAME heightfield (and the sim's collision uses it too, so you
// land on what you see); the inner relief fades to the coarse cap's amplitude at
// its rim and draws on top, so the two meet without a seam.

import * as THREE from 'three';
import type { PlanetKind, SystemDef } from '../sim/types';
import { atmoHeight, atmosphereAt } from '../sim/system';
import { heightField, TERRAIN } from '../sim/terrain';
import { fbm2 } from '../sim/rng';
import type { SceneManager } from './scene';

const SNOW_C = new THREE.Color(0xeef2f6);
const WATER_DEEP_C = new THREE.Color(0x1c3a5e);
const WATER_SHALLOW_C = new THREE.Color(0x2f6f86);

const WHITE_C = new THREE.Color(0xffffff);
const SEG = 192;             // grid resolution per cap (constant; span varies) — finer cells, more detail at altitude
const MAX_SPAN_HALF = 260_000; // cap the coarse reach so the near far-plane stays sane (m)
const REBUILD_MOVE = 55;    // re-noise after the ship moves this far laterally (m)
const REBUILD_SPAN = 0.05;  // ...or after a cap's LOD span changes this fraction

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

// one level-of-detail cap (a curved grid of ground)
interface Cap {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  lastBuild: THREE.Vector3;
  lastSpan: number;
}

export class TerrainPatch {
  private coarse: Cap;
  private fine: Cap;
  private up = new THREE.Vector3();
  private t1 = new THREE.Vector3();
  private t2 = new THREE.Vector3();
  private basis = new THREE.Matrix4();
  private gp = new THREE.Vector3();
  private tmpCol = new THREE.Color();
  private lastPlanet = '';
  private baseXY: Float32Array; // immutable unit grid (the position attr is overwritten with metres)

  // exposed so the renderer can fit the near far-plane and blend the far sphere
  active = false;
  reach = 0;        // distance to the coarse cap's rim (m) — the near far-plane must clear it
  blend = 0;        // 0..1 how fully the near ground has taken over from the far sphere
  planetId = '';

  // AERIAL PERSPECTIVE uniforms (shared by both caps). Real atmospheric depth has
  // two terms: per-channel EXTINCTION (red/green fade faster than blue, so the
  // distance shifts toward the sky) and INSCATTERING (distant ground gains the
  // atmosphere's light and brightens toward blue). That separation into receding
  // luminous layers is what makes terrain read as 3-D from altitude — the key the
  // grey single-colour fog was missing.
  private aerial = {
    uExt: { value: new THREE.Vector3(0, 0, 0) },   // per-channel extinction (1/m, applied to d^2)
    uIns: { value: 0 },                            // inscatter rate (1/m)
    uInsCol: { value: new THREE.Color(0x6fa8d6) }, // inscatter (sky) colour
  };

  constructor(private sm: SceneManager) {
    // unit grid in [-0.5, 0.5]; rebuild() scales it to the current span
    const geo = new THREE.PlaneGeometry(1, 1, SEG, SEG);
    const bp = geo.attributes.position as THREE.BufferAttribute;
    this.baseXY = new Float32Array(bp.count * 2);
    for (let i = 0; i < bp.count; i++) { this.baseXY[i * 2] = bp.getX(i); this.baseXY[i * 2 + 1] = bp.getY(i); }
    this.coarse = this.makeCap(-10, false);
    this.fine = this.makeCap(-9, true); // drawn ON TOP of the coarse cap
  }

  private makeCap(renderOrder: number, onTop: boolean): Cap {
    const geo = new THREE.PlaneGeometry(1, 1, SEG, SEG);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0, flatShading: true,
      emissive: 0x202020, emissiveIntensity: 0.25,
      transparent: true, opacity: 1, depthWrite: true,
      // the fine patch wins the depth test over the coarse cap it overlaps, so no
      // z-fighting where they share ground (same heightfield, same curvature)
      polygonOffset: onTop, polygonOffsetFactor: onTop ? -2 : 0, polygonOffsetUnits: onTop ? -2 : 0,
    });
    this.patchAerialFog(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.renderOrder = renderOrder;
    this.sm.near.add(mesh);
    return { mesh, mat, lastBuild: new THREE.Vector3(Infinity, 0, 0), lastSpan: 0 };
  }

  // Replace three.js' grey single-colour fog on this material with two-term
  // aerial perspective (per-channel extinction + blue inscatter), keyed to the
  // shared uniforms. Keeps the d^2 falloff (crisp near, hazed far) but the
  // distance now goes luminous blue instead of flat grey — readable depth.
  private patchAerialFog(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uExt = this.aerial.uExt;
      shader.uniforms.uIns = this.aerial.uIns;
      shader.uniforms.uInsCol = this.aerial.uInsCol;
      shader.fragmentShader = 'uniform vec3 uExt;\nuniform float uIns;\nuniform vec3 uInsCol;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          vec3 _de = vFogDepth * uExt;
          vec3 _ext = exp(-_de * _de);
          float _di = vFogDepth * uIns;
          float _ins = 1.0 - exp(-_di * _di);
          gl_FragColor.rgb = gl_FragColor.rgb * _ext + uInsCol * _ins;
        #endif`,
      );
    };
    mat.customProgramCacheKey = () => 'vf_aerial_fog';
  }

  update(system: SystemDef, shipPos: { x: number; y: number; z: number }, skyColor: THREE.Color, hazeD: number): void {
    const atmo = atmosphereAt(system, shipPos);
    const p = atmo.planet;
    // aerial perspective: red/green extinguish faster than blue (distance shifts
    // toward the sky) and the inscatter colour is the pale bright horizon, so far
    // ground glows blue instead of greying out. d^2 falloff keeps near ground crisp.
    const base = hazeD * 0.62e-4;
    this.aerial.uExt.value.set(base * 1.3, base * 1.02, base * 0.6);
    this.aerial.uIns.value = base * 0.95;
    this.aerial.uInsCol.value.copy(skyColor).lerp(WHITE_C, 0.35).multiplyScalar(1.05);
    if (!p || atmo.altitude > atmoHeight(p)) {
      this.coarse.mesh.visible = false; this.fine.mesh.visible = false;
      this.active = false; this.blend = 0; this.reach = 0;
      return;
    }
    const R = p.radius;
    const shell = atmoHeight(p);
    const alt = Math.max(20, atmo.altitude);

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
    const wx = p.pos.x + this.up.x * R;
    const wy = p.pos.y + this.up.y * R;
    const wz = p.pos.z + this.up.z * R;

    // --- two LOD spans. The coarse cap reaches out ~3x altitude (capped by the
    //     horizon) for the skyline; the fine patch stays tight so its quads stay
    //     small (~120-180 m) and hills keep their relief from altitude. ---
    const cosH = R / (R + alt);
    const horizonPlanar = R * Math.sqrt(Math.max(0, 1 - cosH * cosH));
    const coarseHalf = Math.min(MAX_SPAN_HALF, horizonPlanar * 1.04, alt * 2.2 + 9_000);
    const fineHalf = Math.min(coarseHalf * 0.5, alt * 0.55 + 3_000, 14_000);
    // amplitude the coarse cap carries at the fine patch's rim, so the fine relief
    // can fade down to exactly that and the two meet without a step
    const coarseRelief = Math.min(1, 50_000 / (coarseHalf * 2));

    this.buildCapIfNeeded(this.coarse, p, wx, wy, wz, coarseHalf, coarseRelief, 0);
    this.buildCapIfNeeded(this.fine, p, wx, wy, wz, fineHalf, 1, coarseRelief);

    // place & orient both caps
    for (const c of [this.coarse, this.fine]) {
      c.mesh.quaternion.setFromRotationMatrix(this.basis);
      c.mesh.position.copy(this.gp);
    }

    // distance from camera (the ship) to the coarse rim, so the far-plane fits it
    const dropRim = R - Math.sqrt(Math.max(0, R * R - coarseHalf * coarseHalf));
    this.reach = Math.hypot(coarseHalf, alt + dropRim) + 4_000;

    // cross-fade in over the top slice of the shell so entry is soft, not a pop
    const fade = Math.min(1, (shell - atmo.altitude) / (shell * 0.45));
    this.blend = fade;
    // low floor-glow keeps the night side off pure black, but stays out of the
    // sun's way so light-and-shadow models the hills (readable form)
    const deep = 1 - Math.min(1, atmo.altitude / shell);
    const emis = 0.08 + 0.22 * deep;
    for (const c of [this.coarse, this.fine]) {
      c.mat.opacity = Math.max(0, fade);
      c.mat.emissiveIntensity = emis;
      c.mat.emissive.copy(GROUND[p.kind].lo).multiplyScalar(0.6);
      c.mesh.visible = true;
    }
    this.lastPlanet = p.id;
    this.active = true;
    this.planetId = p.id;
  }

  private buildCapIfNeeded(c: Cap, p: { id: string; kind: PlanetKind; colorSeed: number; radius: number }, wx: number, wy: number, wz: number, spanHalf: number, reliefCenter: number, reliefRim: number): void {
    const moved = Math.hypot(wx - c.lastBuild.x, wy - c.lastBuild.y, wz - c.lastBuild.z);
    const spanChanged = Math.abs(spanHalf - c.lastSpan) > c.lastSpan * REBUILD_SPAN;
    if (moved <= REBUILD_MOVE && !spanChanged && this.lastPlanet === p.id) return;
    c.lastBuild.set(wx, wy, wz);
    c.lastSpan = spanHalf;
    this.rebuild(c.mesh, p, wx, wz, spanHalf, reliefCenter, reliefRim);
  }

  // Build one cap. Relief runs from `reliefCenter` (under the ship) to `reliefRim`
  // at the cap edge: the coarse cap fades to 0 (flat at the horizon), the fine
  // patch fades to the coarse amplitude (so they overlap seamlessly).
  private rebuild(mesh: THREE.Mesh, p: { kind: PlanetKind; colorSeed: number; radius: number }, wx: number, wz: number, spanHalf: number, reliefCenter: number, reliefRim: number): void {
    const def = GROUND[p.kind];
    const prm = TERRAIN[p.kind];
    const seed = p.colorSeed;
    const R = p.radius;
    const geo = mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const span = spanHalf * 2;
    const rawH = new Float32Array(pos.count); // raw height for LOD-stable colouring
    const vary = new Float32Array(pos.count); // patchy tone variation
    // pass 1: heights. grid is unit [-0.5,0.5]; scale by span. Curvature is the
    // EXACT spherical drop so the rim lands on the real horizon.
    for (let i = 0; i < pos.count; i++) {
      const lx = this.baseXY[i * 2] * span, ly = this.baseXY[i * 2 + 1] * span;
      const u = wx + this.t1.x * lx + this.t2.x * ly;
      const vv = wz + this.t1.z * lx + this.t2.z * ly;
      const s2 = lx * lx + ly * ly;
      const edge = Math.sqrt(s2) / spanHalf;
      // relief amplitude: center value, easing to the rim value over the outer 25%
      const k = edge < 0.75 ? 0 : (edge - 0.75) / 0.25;
      const relief = reliefCenter + (reliefRim - reliefCenter) * (k * k * (3 - 2 * k));
      const r = heightField(u, vv, seed, prm);
      rawH[i] = r;
      vary[i] = fbm2(u * 0.00085, vv * 0.00085, seed ^ 0x55a3, 3);
      const h = r * relief;
      const drop = R - Math.sqrt(Math.max(0, R * R - s2)); // exact sphere curvature
      pos.setXYZ(i, lx, ly, h - drop);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    // pass 2: shade by RAW height (LOD-stable coastlines/snowlines) + slope, with
    // patchy tone variation, water in the basins and snow on the peaks
    const water = p.kind === 'terran';
    const sea = prm.amp * 0.16, snow = prm.amp * 0.82;
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const r = rawH[i];
      const t = Math.min(1, Math.max(0, r / prm.amp));
      this.tmpCol.copy(def.lo).lerp(def.hi, Math.pow(t, 0.7));
      const slope = 1 - Math.min(1, Math.max(0, nor.getZ(i)));
      this.tmpCol.lerp(def.rock, Math.min(1, slope * 2.0) * 0.85);
      this.tmpCol.multiplyScalar(0.82 + vary[i] * 0.34);
      if (r > snow) this.tmpCol.lerp(SNOW_C, Math.min(1, (r - snow) / (prm.amp * 0.18)) * 0.8);
      if (water && r < sea) this.tmpCol.copy(WATER_DEEP_C).lerp(WATER_SHALLOW_C, Math.max(0, r / sea));
      col.setXYZ(i, this.tmpCol.r, this.tmpCol.g, this.tmpCol.b);
    }
    col.needsUpdate = true;
    geo.computeBoundingSphere();
  }
}
