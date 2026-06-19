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
import { fbm3 } from '../sim/rng';
import { isMobile } from '../game/touch';
import type { SceneManager } from './scene';

const SNOW_C = new THREE.Color(0xeef2f6);
const WATER_DEEP_C = new THREE.Color(0x1c3a5e);
const WATER_SHALLOW_C = new THREE.Color(0x2f6f86);

const WHITE_C = new THREE.Color(0xffffff);
// grid resolution per cap. A full rebuild re-noises SEG² vertices (×2 caps) with
// 3-D fbm — quadratic in SEG — so this is the dominant CPU cost on a descent.
// 128 keeps the relief crisp (the per-pixel shader detail fills the rest) while
// cutting rebuild work ~2.2× vs 192, which was hitching mobile frames hard.
// Mobile drops to 96 (another ~1.8× off the rebuild) — phones have far less CPU
// headroom and the per-pixel detail keeps the lower mesh from reading as coarse.
const SEG = isMobile() ? 96 : 128;
const MAX_SPAN_HALF = 380_000; // cap the coarse reach so the near far-plane stays sane (m)
// Re-noise thresholds are PER CAP: the fine patch (≤16 km, ~120 m quads) must
// follow the ship closely, but the coarse cap spans hundreds of km with km-scale
// quads — re-noising it every 55 m was pure waste. Rebuilding it only every few
// hundred metres (or when its LOD span changes) roughly halves the typical
// rebuild load with no visible change.
const REBUILD_MOVE_FINE = 80;
const REBUILD_MOVE_COARSE = 400;
const REBUILD_SPAN = 0.06;  // ...or after a cap's LOD span changes this fraction

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
    uDetail: { value: 0 },                         // detail bump amplitude (m); fades out with distance/altitude
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
    // world XZ of each vertex, so the fragment shader can add WORLD-LOCKED micro
    // detail (bump + speckle) that doesn't swim when the patch recentres
    geo.setAttribute('aWorld', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    // circular edge fade: 1 at center, 0 at the boundary of an inscribed circle,
    // so the square grid fades to a soft disc and no straight edges cross the horizon
    geo.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
    const mat = new THREE.MeshStandardMaterial({
      // smooth shading: the base mesh carries the macro relief, a procedural
      // detail-normal in the shader adds the per-pixel rock texture (no facets)
      vertexColors: true, roughness: 1, metalness: 0, flatShading: false,
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
      shader.uniforms.uDetail = this.aerial.uDetail; // bump amplitude, fades with distance

      // --- vertex: carry world XZ + circular edge fade through ---
      shader.vertexShader = 'attribute vec2 aWorld;\nattribute float aEdge;\nvarying vec2 vWorldXZ;\nvarying float vEdgeFade;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vWorldXZ = aWorld;\n  vEdgeFade = aEdge;',
      );

      // --- fragment: procedural value-noise FBM, a detail bump-normal (tangent-
      //     free, from screen-space derivatives) and an albedo speckle, so the
      //     ground reads as textured rock per-pixel instead of flat vertex colour.
      shader.fragmentShader =
        'uniform vec3 uExt;\nuniform float uIns;\nuniform vec3 uInsCol;\nuniform float uDetail;\nvarying vec2 vWorldXZ;\nvarying float vEdgeFade;\n' +
        `float vfHash(vec2 p){ p = fract(p * vec2(127.31, 311.7)); p += dot(p, p + 34.21); return fract(p.x * p.y); }
         float vfNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
           float a = vfHash(i), b = vfHash(i + vec2(1.0, 0.0)), c = vfHash(i + vec2(0.0, 1.0)), d = vfHash(i + vec2(1.0, 1.0));
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
         float vfFbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * vfNoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
        ` + shader.fragmentShader;

      // perturb the geometric normal by the gradient of a procedural detail height
      // (Morten Mikkelsen's tangent-free bump, the method three uses for bumpMap).
      // Kept to two fbm evaluations — this runs per pixel over the whole ground at
      // low altitude, so it's the dominant GPU cost on mobile; cheaper is better.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         if (uDetail > 0.001) {
           float _wb = step(vColor.r * 1.4, vColor.b) * step(0.04, vColor.b);
           float H = (vfFbm(vWorldXZ * 0.085) + 0.4 * vfFbm(vWorldXZ * 0.35)) * uDetail * (1.0 - _wb);
           vec2 dH = vec2(dFdx(H), dFdy(H));
           vec3 sx = dFdx(-vViewPosition); vec3 sy = dFdy(-vViewPosition);
           vec3 R1 = cross(sy, normal); vec3 R2 = cross(normal, sx);
           float fDet = dot(sx, R1);
           vec3 grad = sign(fDet) * (dH.x * R1 + dH.y * R2);
           normal = normalize(abs(fDet) * normal - grad);
         }`,
      );

      // albedo: biome patches (km scale, readable from altitude) + a mid-scale
      // erosion streak + a fine speckle for close-up rock. Trimmed to two fbm + one
      // noise (was five fbm) to keep the per-pixel cost low on mobile GPUs.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           float biome = vfFbm(vWorldXZ * 0.003 + 41.0);
           float erosion = vfNoise(vWorldXZ * 0.018 + 7.0);
           float spk = vfFbm(vWorldXZ * 0.5 + 19.0);
           diffuseColor.rgb *= 0.62 + 0.18 * biome + 0.12 * erosion + 0.28 * spk;
         }`,
      );

      // water specular: water areas (detected by blue-dominant vertex colour) get
      // low roughness so they catch sunlight as a bright glint on the ocean
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         {
           float _waterB = step(diffuseColor.r * 1.4, diffuseColor.b) * step(0.04, diffuseColor.b);
           roughnessFactor = mix(roughnessFactor, 0.08, _waterB);
         }`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          vec3 _de = vFogDepth * uExt;
          vec3 _ext = exp(-_de * _de);
          float _di = vFogDepth * uIns;
          float _ins = 1.0 - exp(-_di * _di);
          gl_FragColor.rgb = gl_FragColor.rgb * _ext + uInsCol * _ins;
        #endif
        gl_FragColor.a *= vEdgeFade;
        if (gl_FragColor.a < 0.004) discard;`,
      );
    };
    mat.customProgramCacheKey = () => 'vf_aerial_detail';
  }

  update(system: SystemDef, shipPos: { x: number; y: number; z: number }, skyColor: THREE.Color, hazeD: number): void {
    const atmo = atmosphereAt(system, shipPos);
    const p = atmo.planet;
    // aerial perspective: red/green extinguish faster than blue (distance shifts
    // toward the sky) and the inscatter colour is the pale bright horizon, so far
    // ground glows blue instead of greying out. d^2 falloff keeps near ground crisp.
    // gentler than physically-thick so mid-distance terrain stays READABLE from
    // altitude (the brief is: see the relief from high up, not a white wash). The
    // far rim still hazes to the sky, but hills hold form well into the distance.
    // gentler extinction so the terrain reads as a continuous lit surface to the
    // horizon from altitude (not a small clear disc swimming in haze — the "circle"
    // look), with a brighter inscatter so distance lifts toward the daylit sky like
    // real aerial perspective instead of greying/darkening out.
    const base = hazeD * 0.19e-4;
    this.aerial.uExt.value.set(base * 1.25, base * 1.0, base * 0.62);
    this.aerial.uIns.value = base * 0.8;
    this.aerial.uInsCol.value.copy(skyColor).lerp(WHITE_C, 0.45).multiplyScalar(1.25);
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

    // --- two LOD spans. CRUCIAL: the coarse cap must reach the TRUE GEOMETRIC
    //     HORIZON, so the curved ground fully covers the visible planet disc and
    //     fully occludes the far sphere below the skyline. If the cap is any
    //     smaller than the horizon you see a square plate of ground floating on
    //     the bare far sphere (the "cuadrado" bug) — terrain only at the rim.
    //     We push it ~8% past the horizon so even the square's straight edges sit
    //     below the visible horizon line. The fine patch stays tight so its quads
    //     stay small and hills keep readable relief from altitude. ---
    const cosH = R / (R + alt);
    const horizonPlanar = R * Math.sqrt(Math.max(0, 1 - cosH * cosH));
    const coarseHalf = Math.min(MAX_SPAN_HALF, horizonPlanar * 1.22);
    const fineHalf = Math.min(coarseHalf * 0.5, alt * 0.7 + 3_000, 16_000);
    // BOTH caps carry FULL relief and sample the SAME heightfield, so mountain
    // ranges read all the way to the horizon (Elite-Dangerous style) and the two
    // caps align without a step where they overlap. The fine cap just adds
    // resolution + per-pixel detail near the ship; the coarse cap carries the
    // macro massifs out to the skyline. A circular alpha fade on each dissolves
    // the square grid into a disc (the fine into the coarse, the coarse into haze
    // past the horizon), so no straight edge ever crosses the curved horizon.
    this.buildCapIfNeeded(this.coarse, p, wx, wy, wz, coarseHalf, 1, 1, true, REBUILD_MOVE_COARSE);
    this.buildCapIfNeeded(this.fine, p, wx, wy, wz, fineHalf, 1, 1, true, REBUILD_MOVE_FINE);

    // place & orient both caps
    for (const c of [this.coarse, this.fine]) {
      c.mesh.quaternion.setFromRotationMatrix(this.basis);
      c.mesh.position.copy(this.gp);
    }

    // distance from camera (the ship) to the coarse rim, so the far-plane fits it
    const dropRim = R - Math.sqrt(Math.max(0, R * R - coarseHalf * coarseHalf));
    this.reach = Math.hypot(coarseHalf, alt + dropRim) + 4_000;

    // cross-fade in over the TOP slice of the shell so entry is soft, but reach
    // full opacity early (by ~70% of the shell height) so the ground reads as a
    // solid planet surface well before you're deep in — not a translucent disc
    // hanging in the haze through the whole upper atmosphere.
    const fade = Math.min(1, (shell - atmo.altitude) / (shell * 0.3));
    this.blend = fade;
    // low floor-glow keeps the night side off pure black, but must stay well out
    // of the sun's way: a strong fill light flattens the terrain into a uniform
    // wash and kills the light-and-shadow that lets you read hills from altitude.
    // Keep it dim so the sun models the relief (readable form), lift only on the
    // deep night side.
    const deep = 1 - Math.min(1, atmo.altitude / shell);
    const emis = 0.06 + 0.12 * deep;
    // per-pixel detail bump: full strength low down where it reads, fading out by
    // ~8 km where a few-metre bump is sub-pixel (and would just shimmer)
    this.aerial.uDetail.value = 30 * Math.max(0, 1 - atmo.altitude / 8_000);
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

  private buildCapIfNeeded(c: Cap, p: { id: string; kind: PlanetKind; colorSeed: number; radius: number }, wx: number, wy: number, wz: number, spanHalf: number, reliefCenter: number, reliefRim: number, fadeRim: boolean, moveThreshold: number): void {
    const moved = Math.hypot(wx - c.lastBuild.x, wy - c.lastBuild.y, wz - c.lastBuild.z);
    const spanChanged = Math.abs(spanHalf - c.lastSpan) > c.lastSpan * REBUILD_SPAN;
    if (moved <= moveThreshold && !spanChanged && this.lastPlanet === p.id) return;
    c.lastBuild.set(wx, wy, wz);
    c.lastSpan = spanHalf;
    this.rebuild(c.mesh, p, wx, wz, spanHalf, reliefCenter, reliefRim, fadeRim);
  }

  // Build one cap. Relief runs from `reliefCenter` (under the ship) to `reliefRim`
  // at the cap edge. `fadeRim` turns on the circular alpha fade that dissolves the
  // square grid into a disc at the rim (so no straight edges cross the horizon).
  private rebuild(mesh: THREE.Mesh, p: { kind: PlanetKind; colorSeed: number; radius: number }, wx: number, wz: number, spanHalf: number, reliefCenter: number, reliefRim: number, fadeRim: boolean): void {
    const def = GROUND[p.kind];
    const prm = TERRAIN[p.kind];
    const seed = p.colorSeed;
    const R = p.radius;
    const geo = mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const aw = geo.attributes.aWorld as THREE.BufferAttribute;
    const ae = geo.attributes.aEdge as THREE.BufferAttribute;
    const span = spanHalf * 2;
    const rawH = new Float32Array(pos.count); // raw height for LOD-stable colouring
    const vary = new Float32Array(pos.count); // patchy tone variation (~1.2 km scale)
    const biome = new Float32Array(pos.count); // continental biome regions (~7 km scale)
    // pass 1: heights. grid is unit [-0.5,0.5]; scale by span. Curvature is the
    // EXACT spherical drop so the rim lands on the real horizon.
    for (let i = 0; i < pos.count; i++) {
      const lx = this.baseXY[i * 2] * span, ly = this.baseXY[i * 2 + 1] * span;
      const u = wx + this.t1.x * lx + this.t2.x * ly;
      const vv = wz + this.t1.z * lx + this.t2.z * ly;
      // 3-D direction from the planet centre to this vertex (sub-ship surface
      // point is up*R; offset along the tangent axes). Sampling the heightfield
      // and tone fields on this direction — not on world (X,Z) — is what keeps
      // the relief seamless and spike-free at any orientation on the globe.
      const rx = this.up.x * R + this.t1.x * lx + this.t2.x * ly;
      const ry = this.up.y * R + this.t1.y * lx + this.t2.y * ly;
      const rz = this.up.z * R + this.t1.z * lx + this.t2.z * ly;
      const s2 = lx * lx + ly * ly;
      const edge = Math.sqrt(s2) / spanHalf;
      // circular fade: inscribed circle of the square grid → smooth disc so no
      // straight edges ever cross the curved horizon. Applied to BOTH caps now —
      // the fine cap dissolves into the coarse, the coarse into the haze.
      const ef = !fadeRim ? 1 : edge < 0.88 ? 1 : edge > 1.02 ? 0 : 1 - Math.pow((edge - 0.88) / 0.14, 2);
      ae.setX(i, Math.max(0, ef));
      // relief amplitude: center value, easing to the rim value over the outer
      // 25%. k MUST be clamped to [0,1]: the square patch's corners sit at
      // edge≈1.41, and an unclamped smoothstep k²(3−2k) explodes hugely negative
      // there, multiplying the relief into a 30 km spike at the fine patch corners
      // (the "pico"/"cuadrado" artifact). Clamped, corners settle to the rim amp.
      const k = edge < 0.75 ? 0 : Math.min(1, (edge - 0.75) / 0.25);
      const relief = reliefCenter + (reliefRim - reliefCenter) * (k * k * (3 - 2 * k));
      const r = heightField(rx, ry, rz, R, seed, prm);
      rawH[i] = r;
      vary[i] = fbm3(rx * 0.00085, ry * 0.00085, rz * 0.00085, seed ^ 0x55a3, 2);
      biome[i] = fbm3(rx * 0.00014, ry * 0.00014, rz * 0.00014, seed ^ 0xb0b1, 2);
      const h = r * relief;
      const drop = R - Math.sqrt(Math.max(0, R * R - s2)); // exact sphere curvature
      pos.setXYZ(i, lx, ly, h - drop);
      aw.setXY(i, u, vv); // world XZ for shader detail (world-locked)
    }
    pos.needsUpdate = true;
    aw.needsUpdate = true;
    ae.needsUpdate = true;
    geo.computeVertexNormals();
    // pass 2: shade by RAW height (LOD-stable coastlines/snowlines) + slope, with
    // patchy tone variation, water in the basins, bare rock on the steeps and
    // snow capping the high ranges. Heights now span ~0..2.3*amp (plains -> peaks),
    // so the bands are keyed to that full range, not just [0,amp].
    const water = p.kind === 'terran';
    const sea = prm.amp * 0.14;          // low plains/basins flood (terran)
    const snow = prm.amp * 1.30;         // only the high ranges get a snow cap
    const hiRange = prm.amp * 2.2;       // height that maps to the top of the lo->hi gradient
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const r = rawH[i];
      const t = Math.min(1, Math.max(0, r / hiRange));
      this.tmpCol.copy(def.lo).lerp(def.hi, Math.pow(t, 0.8));
      // steep faces are bare rock (and snow can't cling to them)
      const slope = 1 - Math.min(1, Math.max(0, nor.getZ(i)));
      this.tmpCol.lerp(def.rock, Math.min(1, slope * 2.2) * 0.9);
      // two-scale tone variation: continental biome (~7 km patches readable from
      // orbit) and local tone (~1.2 km patches for mid-altitude interest)
      this.tmpCol.multiplyScalar(0.72 + biome[i] * 0.24 + vary[i] * 0.26);
      if (r > snow) {
        const cap = Math.min(1, (r - snow) / (prm.amp * 0.55)) * (1 - Math.min(1, slope * 1.6)) * 0.92;
        this.tmpCol.lerp(SNOW_C, Math.max(0, cap));
      }
      if (water && r < sea) this.tmpCol.copy(WATER_DEEP_C).lerp(WATER_SHALLOW_C, Math.max(0, r / sea));
      col.setXYZ(i, this.tmpCol.r, this.tmpCol.g, this.tmpCol.b);
    }
    col.needsUpdate = true;
    geo.computeBoundingSphere();
  }
}
