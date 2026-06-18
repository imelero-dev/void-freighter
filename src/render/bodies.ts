// Star, planets, moons and stations — all geometry/material procedural.
// Planets/star/far-markers live in the far scene (km units); the detailed
// station mesh lives in the near scene and is positioned every frame.

import * as THREE from 'three';
import { Rng, fbm2, fbm3 } from '../sim/rng';
import type { PlanetDef, StationDef, SystemDef } from '../sim/types';
import { hangarFrame } from '../sim/docking';
import { atmoHeight } from '../sim/system';
import { FAR_SCALE, SceneManager } from './scene';
import { GROUND_MID } from './terrain';

const tmp = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Planet textures
// ---------------------------------------------------------------------------

function planetTexture(p: PlanetDef): THREE.CanvasTexture {
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const seed = p.colorSeed;

  const put = (i: number, r: number, g: number, b: number) => {
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  };

  for (let y = 0; y < H; y++) {
    const lat = y / H;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // wrap-friendly sampling
      const u = x / W * 6, v = lat * 3;
      const n = fbm2(u, v, seed, 5);
      const n2 = fbm2(u * 2.3 + 11, v * 2.3, seed ^ 0xa5, 4);
      switch (p.kind) {
        case 'lava': {
          const cracks = Math.max(0, 0.5 - Math.abs(n - 0.5) * 4) * 2;
          const glow = Math.pow(cracks, 2.2);
          put(i, 26 + n2 * 22 + glow * 210, 20 + n2 * 14 + glow * 70, 18 + n2 * 12);
          break;
        }
        case 'rocky': {
          const g = 60 + n * 90;
          put(i, g * 1.08, g * 0.92, g * 0.78);
          break;
        }
        case 'terran': {
          if (n > 0.52) {
            const land = (n - 0.52) * 5;
            put(i, 52 + land * 40 + n2 * 18, 72 + land * 36 + n2 * 14, 36 + land * 12);
          } else {
            const deep = (0.52 - n) * 3;
            put(i, 16, 36 - deep * 14, 64 - deep * 18);
          }
          break;
        }
        case 'gas': {
          const band = Math.sin(lat * Math.PI * 9 + n * 2.5) * 0.5 + 0.5;
          put(i, 120 + band * 60 + n2 * 24, 96 + band * 40 + n2 * 16, 70 + band * 24);
          break;
        }
        case 'ice': {
          const g = 150 + n * 80;
          put(i, g * 0.86, g * 0.95, Math.min(255, g * 1.06));
          break;
        }
        case 'barren': {
          const g = 70 + n * 60 - n2 * 24;
          put(i, g, g * 0.98, g * 0.92);
          break;
        }
      }
      // polar darkening for a harder look
      const polar = Math.pow(Math.abs(lat - 0.5) * 2, 3) * 0.35;
      d[i] *= 1 - polar;
      d[i + 1] *= 1 - polar;
      d[i + 2] *= 1 - polar;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Wispy cloud layer for worlds with weather: white with an fbm alpha mask so it
// reads as broken cloud, lit by the sun (day bright / night dark) on a slightly
// larger sphere that drifts independently of the surface.
function cloudTexture(seed: number): THREE.CanvasTexture {
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const lat = y / H;
    const band = 0.6 + 0.4 * Math.sin(lat * Math.PI); // thinner clouds at the poles
    for (let x = 0; x < W; x++) {
      const n = fbm2(x / W * 6, lat * 3, seed, 5);
      const m = fbm2(x / W * 13 + 7, lat * 6, seed ^ 0x9d, 4);
      let a = Math.max(0, (n * 0.7 + m * 0.5) - 0.62) * 3.2 * band;
      a = Math.min(1, a);
      const i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 245;
      d[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Rim-glow atmosphere shader — the bright limb halo you see ringing an
// atmospheric world from space (the signature blue arc on a planet's edge).
// Three layers of scatter: a wide soft outer Rayleigh glow, the main body of
// scattered light, and a thin hot limb at the very edge. The inner scatter
// whitens where the optical path is longest (like real atmosphere). A warm
// terminator band glows where low-angle sunlight threads through thick air.
function atmosphereMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { c: { value: color } },
    ]),
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec3 vN; varying vec3 vV; varying vec3 vWN; varying vec3 vWorld;
      void main() {
        vN = normalize(normalMatrix * normal);
        vWN = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mvPosition.xyz);
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform vec3 c; varying vec3 vN; varying vec3 vV; varying vec3 vWN; varying vec3 vWorld;
      void main() {
        float f = 1.0 - abs(dot(vN, vV));
        float outer = pow(f, 1.5) * 0.20;
        float body  = pow(f, 2.2) * 0.72;
        float limb  = pow(f, 5.5) * 1.5;
        float halo  = outer + body + limb;
        vec3 col = mix(c, vec3(1.0), smoothstep(0.4, 0.95, f) * 0.4);
        vec3 sunDir = normalize(-vWorld);
        float sunDot = dot(vWN, sunDir);
        float lit = max(0.08, clamp(0.3 + 0.8 * sunDot, 0.0, 1.0));
        float termBand = exp(-8.0 * (sunDot + 0.1) * (sunDot + 0.1));
        col = mix(col, vec3(1.0, 0.72, 0.38), termBand * 0.35);
        gl_FragColor = vec4(col, clamp(halo * lit, 0.0, 1.0));
        #ifdef USE_FOG
          float fogFactor = 1.0 - exp( -fogDensity * fogDensity * vFogDepth * vFogDepth );
          gl_FragColor.a *= 1.0 - fogFactor;
        #endif
      }`,
  });
}

// Displace a planet sphere's vertices into real terrain relief: ridged
// multi-octave noise for mountains on solid worlds, gentler for ice.
function displacePlanet(geo: THREE.BufferGeometry, seed: number, kind: PlanetDef['kind'], relief: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const ridged = kind !== 'ice';
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;
    let h = 0, amp = 1, freq = 2.0, norm = 0;
    for (let o = 0; o < 6; o++) {
      let n = fbm3(nx * freq, ny * freq, nz * freq, seed + o * 97, 2);
      if (ridged) n = 1 - Math.abs(n * 2 - 1);
      h += n * amp; norm += amp; amp *= 0.5; freq *= 2.0;
    }
    const d = (h / norm - 0.5) * 2 * relief;
    pos.setXYZ(i, x + nx * d, y + ny * d, z + nz * d);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function glowSprite(color: string, size: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, color);
  g.addColorStop(0.35, color.replace(')', ',0.45)').replace('rgb', 'rgba'));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

// ---------------------------------------------------------------------------
// Station mesh (near scene, ~900 m radius)
// ---------------------------------------------------------------------------

function panelTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const rng = new Rng(seed);
  ctx.fillStyle = '#3a3d41';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 160; i++) {
    const x = rng.range(0, 256), y = rng.range(0, 256);
    const w = rng.range(8, 48), h = rng.range(6, 30);
    const g = rng.range(0.7, 1.15);
    ctx.fillStyle = `rgb(${Math.round(52 * g)}, ${Math.round(55 * g)}, ${Math.round(58 * g)})`;
    ctx.fillRect(x, y, w, h);
    if (rng.chance(0.18)) { // rust streaks
      ctx.fillStyle = 'rgba(110, 64, 34, 0.25)';
      ctx.fillRect(x, y, w, rng.range(2, 6));
    }
  }
  // a few lit windows
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = rng.chance(0.7) ? 'rgba(255, 200, 120, 0.85)' : 'rgba(140, 190, 210, 0.8)';
    ctx.fillRect(rng.range(0, 256), rng.range(0, 256), 2, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface StationView {
  def: StationDef;
  group: THREE.Group;       // near-scene detail
  ring: THREE.Mesh | null;
  blinkers: THREE.Mesh[];
  marker: THREE.Group;      // far-scene beacon
  hatch: THREE.Object3D[];  // hangar doors that slide open on approach
  guides: THREE.Mesh[];     // pulsing interior approach lights
  chevrons: THREE.Mesh[];   // "follow-me" wave leading to the pad
}

// A station is a chunky box hull (Coriolis-style) with a single hangar "mail
// slot" cut into the +f dock face. You fly in through the slot and set down on
// the pad inside. Built entirely in the station's own (u,v,f) frame so the
// visible hangar lines up exactly with the collider and the dock check: the
// group is oriented by the (u,v,f) basis, local +X=u, +Y=v, +Z=f.
function buildStationMesh(def: StationDef): {
  group: THREE.Group; ring: THREE.Mesh | null; blinkers: THREE.Mesh[];
  hatch: THREE.Object3D[]; guides: THREE.Mesh[]; chevrons: THREE.Mesh[];
} {
  const rng = new Rng(def.seed);
  const fr = hangarFrame(def);
  const R = def.radius;
  const group = new THREE.Group();
  // orient the whole station by its (u,v,f) basis (world directions)
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(fr.u.x, fr.u.y, fr.u.z),
    new THREE.Vector3(fr.v.x, fr.v.y, fr.v.z),
    new THREE.Vector3(fr.f.x, fr.f.y, fr.f.z),
  ));

  const tex = panelTexture(def.seed);
  // DoubleSide everywhere so flying inside the hangar never shows see-through
  // walls (you'd otherwise look at back-face-culled interior panels)
  const hull = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0.6, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x202327, roughness: 0.95, metalness: 0.35, side: THREE.DoubleSide });
  const interiorMat = new THREE.MeshStandardMaterial({ color: 0x3a414a, roughness: 0.9, metalness: 0.3, emissive: 0x2a3442, emissiveIntensity: 1.0, side: THREE.DoubleSide });
  const lit = (color: number) => new THREE.MeshBasicMaterial({ color });

  const HX = fr.HX, HY = fr.HY, HZ = fr.HZ;     // hull half-extents (metres)
  const HW = fr.HW, HH = fr.HH;                 // hangar slot half sizes
  const backA = fr.backA, padA = fr.padA, padR = fr.padR, floorV = fr.floorV;
  const t = R * 0.025;                          // interior panel thickness

  const mkBox = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(cx, cy, cz);
    group.add(m);
    return m;
  };

  // --- solid hull: a big rear block + a front face framed around the slot ---
  const frontZc = (backA + HZ) / 2, frontD = HZ - backA;
  mkBox(0, 0, (-HZ + backA) / 2, 2 * HX, 2 * HY, backA + HZ, hull);              // rear mass
  mkBox(0, (HH + HY) / 2, frontZc, 2 * HX, HY - HH, frontD, hull);              // above the slot
  mkBox(0, -(HH + HY) / 2, frontZc, 2 * HX, HY - HH, frontD, hull);            // below the slot
  mkBox(-(HW + HX) / 2, 0, frontZc, HX - HW, 2 * HH, frontD, hull);            // left of the slot
  mkBox((HW + HX) / 2, 0, frontZc, HX - HW, 2 * HH, frontD, hull);             // right of the slot

  // --- hangar interior: dark room lining the slot ---
  const depthZc = (backA + HZ) / 2, depthLen = HZ - backA;
  mkBox(0, -HH, depthZc, 2 * HW, t, depthLen, interiorMat);                     // floor
  mkBox(0, HH, depthZc, 2 * HW, t, depthLen, interiorMat);                      // ceiling
  mkBox(-HW, 0, depthZc, t, 2 * HH, depthLen, interiorMat);                     // left wall
  mkBox(HW, 0, depthZc, t, 2 * HH, depthLen, interiorMat);                      // right wall
  mkBox(0, 0, backA, 2 * HW, 2 * HH, t, interiorMat);                           // back wall

  // landing pad on the floor (emissive ring + deck)
  const padDeck = new THREE.Mesh(new THREE.CylinderGeometry(padR, padR, t * 1.4, 28), new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.8, metalness: 0.4, emissive: 0x202a33, emissiveIntensity: 0.5 }));
  padDeck.position.set(0, floorV + t, padA);
  group.add(padDeck);
  const padRing = new THREE.Mesh(new THREE.TorusGeometry(padR * 0.82, R * 0.012, 8, 36), lit(0x66ddff));
  padRing.rotation.x = Math.PI / 2;
  padRing.position.set(0, floorV + t * 1.6, padA);
  group.add(padRing);
  const guides: THREE.Mesh[] = [padRing];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const g = new THREE.Mesh(new THREE.SphereGeometry(R * 0.016, 6, 6), lit(i % 2 ? 0xffffff : 0x66ddff));
    g.position.set(Math.cos(a) * padR * 0.92, floorV + t * 2, padA + Math.sin(a) * padR * 0.92);
    group.add(g);
    guides.push(g);
  }
  // approach chevrons leading from the mouth in to the pad — animated as a
  // "follow-me" wave travelling toward the pad in update()
  const chevrons: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const z = HZ - (i + 0.5) * (HZ - padA) / 6;
    const ch = new THREE.Mesh(new THREE.BoxGeometry(HW * (0.6 - i * 0.05), t * 0.6, R * 0.05), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.5 }));
    ch.position.set(0, floorV + t * 1.5, z);
    group.add(ch);
    chevrons.push(ch);
  }
  // ceiling strip lights so the bay reads as lit from within
  for (const sx of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(R * 0.02, R * 0.02, depthLen * 0.9), lit(0xbfe6ff));
    strip.position.set(sx * HW * 0.7, HH - t * 1.5, depthZc);
    group.add(strip);
  }
  const bayLight = new THREE.PointLight(0x9fd8ff, 3.0, R * 3, 1.1);
  bayLight.position.set(0, HH * 0.4, padA);
  group.add(bayLight);
  const backLight = new THREE.PointLight(0xbfe6ff, 2.0, R * 2.4, 1.2);
  backLight.position.set(0, HH * 0.3, backA + R * 0.2);
  group.add(backLight);
  const mouthLight = new THREE.PointLight(0xffd9a8, 1.4, R * 2.2, 1.4);
  mouthLight.position.set(0, 0, HZ * 0.7);
  group.add(mouthLight);

  // --- hangar interior furniture: makes the bay a working dock, not a box ---
  const crateMat = (i: number) => new THREE.MeshStandardMaterial({ color: i % 2 ? 0x5a4f3a : 0x3f4c58, roughness: 0.92, metalness: 0.3 });
  // cargo stacks tucked into the two back corners, clear of the pad
  for (const sx of [-1, 1]) {
    const baseX = sx * HW * 0.66, baseZ = backA + R * 0.14;
    const cs = R * 0.1;
    for (let i = 0; i < 4; i++) {
      const cr = new THREE.Mesh(new THREE.BoxGeometry(cs, cs, cs), crateMat(i));
      cr.position.set(baseX + (i % 2 ? cs * 0.9 : 0), floorV + cs * 0.5 + (i > 1 ? cs : 0), baseZ + (i % 2 ? cs * 0.6 : 0));
      group.add(cr);
    }
  }
  // a lit control-room window set into the +u wall, overlooking the pad
  const ctrl = new THREE.Mesh(new THREE.BoxGeometry(t * 1.5, HH * 0.5, R * 0.34), new THREE.MeshStandardMaterial({ color: 0x1a2630, emissive: 0xffcf87, emissiveIntensity: 0.7, roughness: 0.5 }));
  ctrl.position.set(HW - t, HH * 0.35, padA);
  group.add(ctrl);
  const ctrlFrame = new THREE.Mesh(new THREE.BoxGeometry(t * 2.2, HH * 0.62, R * 0.4), dark);
  ctrlFrame.position.set(HW - t * 1.4, HH * 0.35, padA);
  group.add(ctrlFrame);
  // overhead gantry beam across the bay near the back, with a hanging hoist
  const gantry = new THREE.Mesh(new THREE.BoxGeometry(2 * HW * 0.9, R * 0.05, R * 0.06), dark);
  gantry.position.set(0, HH - R * 0.06, backA + R * 0.32);
  group.add(gantry);
  const hoist = new THREE.Mesh(new THREE.BoxGeometry(R * 0.05, R * 0.16, R * 0.05), dark);
  hoist.position.set(-HW * 0.3, HH - R * 0.16, backA + R * 0.32);
  group.add(hoist);
  // conduit runs along the lower side walls
  for (const sx of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.018, R * 0.018, depthLen * 0.8, 8), new THREE.MeshStandardMaterial({ color: 0x6e6a60, roughness: 0.7, metalness: 0.6 }));
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(sx * (HW - t * 2), floorV + HH * 0.5, depthZc);
    group.add(pipe);
  }

  // sliding hangar doors (two panels closing the slot, tucked into the jambs)
  const hatch: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(HW, 2 * HH, t * 1.5), hull);
    door.position.set(side * HW / 2, 0, HZ - t);
    door.userData.closedX = side * HW / 2;
    door.userData.openX = side * (HW * 1.5);
    group.add(door);
    hatch.push(door);
  }
  // amber slot-frame lights so the entrance is obvious from a distance
  for (let i = 0; i < 6; i++) {
    const onTop = i < 3;
    const fxp = (i % 3 - 1) * HW * 0.8;
    const g = new THREE.Mesh(new THREE.SphereGeometry(R * 0.02, 6, 6), lit(0xffaa33));
    g.position.set(fxp, (onTop ? 1 : -1) * (HH + t), HZ);
    group.add(g);
  }

  // --- exterior greebles: habitat ring, modules, antennae, nav blinkers ---
  let ring: THREE.Mesh | null = null;
  if (rng.chance(0.85)) {
    ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.95, R * 0.06, 10, 40), hull);
    ring.position.z = -HZ * 0.2;
    group.add(ring);
  }
  const mods = rng.int(4, 7);
  for (let i = 0; i < mods; i++) {
    const face = rng.int(0, 3);
    const s = rng.range(0.12, 0.26) * R;
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, rng.range(0.08, 0.16) * R), hull);
    const off = rng.range(-0.6, 0.6);
    if (face === 0) m.position.set(off * HX, HY, rng.range(-0.5, 0.2) * HZ);
    else if (face === 1) m.position.set(off * HX, -HY, rng.range(-0.5, 0.2) * HZ);
    else if (face === 2) m.position.set(HX, off * HY, rng.range(-0.5, 0.2) * HZ);
    else m.position.set(-HX, off * HY, rng.range(-0.5, 0.2) * HZ);
    m.rotation.set(rng.range(0, 0.4), rng.range(0, 0.4), rng.range(0, 0.4));
    group.add(m);
  }
  for (let i = 0; i < rng.int(3, 5); i++) {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.006, R * 0.006, rng.range(0.3, 0.7) * R, 4), dark);
    ant.position.set(rng.range(-0.7, 0.7) * HX, HY + rng.range(0.1, 0.3) * R, rng.range(-0.7, 0) * HZ);
    group.add(ant);
  }
  const blinkers: THREE.Mesh[] = [];
  for (const corner of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
    const tip = new THREE.Mesh(new THREE.SphereGeometry(R * 0.025, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff3322 }));
    tip.position.set(corner[0] * HX, corner[1] * HY, HZ);
    group.add(tip);
    blinkers.push(tip);
  }

  group.traverse((node) => {
    const m = node as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return { group, ring, blinkers, hatch, guides, chevrons };
}

// ---------------------------------------------------------------------------

export class BodiesLayer {
  stations: StationView[] = [];
  private planetMeshes: { def: PlanetDef; mesh: THREE.Mesh }[] = [];
  private clouds: THREE.Mesh[] = [];
  private starMesh: THREE.Group;
  private entryBlendId = '';

  constructor(private sm: SceneManager, system: SystemDef) {
    // star
    this.starMesh = new THREE.Group();
    const starR = system.starRadius * FAR_SCALE;
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(starR, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff0d8 }),
    );
    this.starMesh.add(core);
    this.starMesh.add(glowSprite('rgb(255,238,210)', starR * 3.2)); // hot inner core
    this.starMesh.add(glowSprite('rgb(255,176,80)', starR * 9));    // main glow
    this.starMesh.add(glowSprite('rgb(255,130,54)', starR * 22));   // wide faint corona
    // the sun burns through the daylight haze — exempt it from the far fog so
    // it stays visible in the sky from a planet surface
    this.starMesh.traverse((o) => {
      const m = (o as THREE.Mesh).material as (THREE.Material & { fog?: boolean }) | undefined;
      if (m) m.fog = false;
    });
    sm.far.add(this.starMesh);

    // planets + moons
    for (const p of system.planets) {
      const tex = planetTexture(p);
      // solid worlds get real geometric relief so mountains read during descent
      const solid = p.kind !== 'gas';
      const geo = new THREE.SphereGeometry(p.radius * FAR_SCALE, solid ? 200 : 64, solid ? 100 : 32);
      if (solid) displacePlanet(geo, p.colorSeed, p.kind, p.radius * FAR_SCALE * 0.004);
      const mesh = new THREE.Mesh(
        geo,
        // a faint self-glow from the surface texture keeps the night side from
        // reading as a black hole punched in the starfield during a dark-side
        // descent — lava glows hot, the rest just barely lifts off pure black
        new THREE.MeshStandardMaterial({
          map: tex, roughness: 1, metalness: 0, flatShading: false,
          emissiveMap: tex, emissive: 0xffffff,
          emissiveIntensity: p.kind === 'lava' ? 0.35 : 0.06,
        }),
      );
      if (p.kind !== 'barren' && p.kind !== 'rocky') {
        const atmoColor = p.kind === 'lava' ? new THREE.Color(0xcc4422)
          : p.kind === 'gas' ? new THREE.Color(0xcc9966)
            : p.kind === 'ice' ? new THREE.Color(0x88bbdd) : new THREE.Color(0x6699cc);
        // the halo shell stands off the surface by the real atmosphere height so
        // the glowing arc reads at the right scale from space
        const shellR = (p.radius + atmoHeight(p) * 1.8) * FAR_SCALE;
        const atmo = new THREE.Mesh(new THREE.SphereGeometry(shellR, 64, 32), atmosphereMaterial(atmoColor));
        mesh.add(atmo);
      }
      // weather: a drifting broken-cloud shell on worlds that have an ocean/ice
      if (p.kind === 'terran' || p.kind === 'ice') {
        const cloud = new THREE.Mesh(
          new THREE.SphereGeometry(p.radius * FAR_SCALE * 1.015, 48, 24),
          new THREE.MeshStandardMaterial({ map: cloudTexture(p.colorSeed ^ 0xc10d), transparent: true, depthWrite: false, roughness: 1, metalness: 0, opacity: p.kind === 'ice' ? 0.7 : 0.9 }),
        );
        mesh.add(cloud);
        this.clouds.push(cloud);
      }
      if (p.ringed) {
        const ringTexC = document.createElement('canvas');
        ringTexC.width = 128;
        ringTexC.height = 4;
        const rctx = ringTexC.getContext('2d')!;
        const rrng = new Rng(p.colorSeed ^ 0x4143);
        for (let x = 0; x < 128; x++) {
          const a = rrng.next() * 0.5 + 0.15;
          rctx.fillStyle = `rgba(180,160,130,${x < 6 || x > 122 ? 0 : a})`;
          rctx.fillRect(x, 0, 1, 4);
        }
        const rtex = new THREE.CanvasTexture(ringTexC);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(p.radius * FAR_SCALE * 1.4, p.radius * FAR_SCALE * 2.6, 64),
          new THREE.MeshBasicMaterial({ map: rtex, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
        );
        // map ring texture radially
        const pos = ring.geometry.attributes.position;
        const uv = ring.geometry.attributes.uv;
        const inner = p.radius * FAR_SCALE * 1.4, outer = p.radius * FAR_SCALE * 2.6;
        for (let i = 0; i < pos.count; i++) {
          const r = Math.hypot(pos.getX(i), pos.getY(i));
          uv.setXY(i, (r - inner) / (outer - inner), 0.5);
        }
        ring.rotation.x = Math.PI / 2 + 0.18;
        mesh.add(ring);
      }
      mesh.rotation.z = 0.1;
      this.planetMeshes.push({ def: p, mesh });
      sm.far.add(mesh);
    }
    for (const m of system.moons) {
      const rng = new Rng(m.colorSeed);
      const g = Math.round(rng.range(80, 140));
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(m.radius * FAR_SCALE, 20, 12),
        new THREE.MeshStandardMaterial({ color: (g << 16) | (g << 8) | g, roughness: 1 }),
      );
      this.planetMeshes.push({ def: { ...m, kind: 'barren', name: m.id, ringed: false, stationId: null } as unknown as PlanetDef, mesh });
      sm.far.add(mesh);
    }

    // stations: near detail + far beacon
    for (const def of system.stations) {
      const { group, ring, blinkers, hatch, guides, chevrons } = buildStationMesh(def);
      group.visible = false;
      sm.near.add(group);
      const marker = new THREE.Group();
      const beacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(2.2),
        new THREE.MeshBasicMaterial({ color: 0x99ccee }),
      );
      marker.add(beacon, glowSprite('rgb(150,200,235)', 14));
      sm.far.add(marker);
      this.stations.push({ def, group, ring, blinkers, marker, hatch, guides, chevrons });
    }
  }

  // As the near ground cap fades in on a descent, tint the descended planet's
  // far-scene sphere toward the local ground tone so the brief cross-fade at the
  // atmosphere interface has nothing to seam against. Reset every other planet to
  // its true surface texture (white tint).
  setEntryBlend(planetId: string, blend: number): void {
    if (this.entryBlendId === planetId && (planetId === '' || blend <= 0)) {
      if (planetId === '') return;
    }
    for (const { def, mesh } of this.planetMeshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat || !mat.color) continue;
      if (def.id === planetId && blend > 0) {
        const g = GROUND_MID[def.kind] ?? GROUND_MID.barren;
        mat.color.setRGB(1, 1, 1).lerp(g, Math.min(1, blend));
      } else if (mat.color.r !== 1 || mat.color.g !== 1 || mat.color.b !== 1) {
        mat.color.setRGB(1, 1, 1);
      }
    }
    this.entryBlendId = planetId;
  }

  update(time: number): void {
    const sm = this.sm;
    this.starMesh.position.copy(sm.toFar({ x: 0, y: 0, z: 0 }, tmp));
    for (const { def, mesh } of this.planetMeshes) {
      mesh.position.copy(sm.toFar(def.pos, tmp));
      mesh.rotation.y = time * 0.005;
    }
    // clouds drift a touch faster than the surface they sit on
    for (const c of this.clouds) c.rotation.y = time * 0.0022;
    for (const sv of this.stations) {
      const dx = sv.def.pos.x - sm.origin.x;
      const dy = sv.def.pos.y - sm.origin.y;
      const dz = sv.def.pos.z - sm.origin.z;
      const dist = Math.hypot(dx, dy, dz);
      const nearVisible = dist < 60_000;
      sv.group.visible = nearVisible;
      sv.marker.visible = !nearVisible;
      if (nearVisible) {
        sv.group.position.set(dx, dy, dz);
        if (sv.ring) sv.ring.rotation.z = time * 0.05;
        const blink = Math.sin(time * 4 + sv.def.seed % 10) > 0.4;
        for (const b of sv.blinkers) b.visible = blink;
        // hangar doors slide apart as you enter the approach envelope
        if (sv.hatch.length) {
          const open = dist < sv.def.dockRadius * 1.25 ? 1 : 0;
          for (const panel of sv.hatch) {
            const cx = panel.userData.closedX as number;
            const ox = panel.userData.openX as number;
            panel.position.x += (cx + (ox - cx) * open - panel.position.x) * Math.min(1, 0.06);
          }
        }
        // interior guide lights pulse so the pad reads as "live"
        const pulse = 0.55 + 0.45 * Math.sin(time * 3);
        for (const g of sv.guides) {
          const mat = g.material as THREE.MeshBasicMaterial;
          if (mat && 'opacity' in mat) { mat.transparent = true; mat.opacity = pulse; }
        }
        // chevrons light up in sequence, a wave running in toward the pad
        const head = (time * 2.2) % (sv.chevrons.length + 2);
        for (let i = 0; i < sv.chevrons.length; i++) {
          const d = Math.abs(i - head);
          const mat = sv.chevrons[i].material as THREE.MeshBasicMaterial;
          mat.opacity = 0.28 + 0.72 * Math.max(0, 1 - d * 0.8);
        }
      } else {
        sv.marker.position.copy(sm.toFar(sv.def.pos, tmp));
      }
    }
  }
}
