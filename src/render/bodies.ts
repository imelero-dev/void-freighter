// Star, planets, moons and stations — all geometry/material procedural.
// Planets/star/far-markers live in the far scene (km units); the detailed
// station mesh lives in the near scene and is positioned every frame.

import * as THREE from 'three';
import { Rng, fbm2 } from '../sim/rng';
import type { PlanetDef, StationDef, SystemDef } from '../sim/types';
import { FAR_SCALE, SceneManager } from './scene';

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

// rim-glow atmosphere shader
function atmosphereMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { c: { value: color } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 c; varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = pow(1.0 - abs(dot(vN, vV)), 2.6);
        gl_FragColor = vec4(c, rim * 0.55);
      }`,
  });
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
}

function buildStationMesh(def: StationDef): { group: THREE.Group; ring: THREE.Mesh | null; blinkers: THREE.Mesh[] } {
  const rng = new Rng(def.seed);
  const group = new THREE.Group();
  const tex = panelTexture(def.seed);
  const hull = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c2f, roughness: 0.9, metalness: 0.4 });

  // central spine
  const spineLen = def.radius * 1.9;
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(def.radius * 0.16, def.radius * 0.2, spineLen, 10), hull);
  group.add(spine);

  // habitat ring
  let ring: THREE.Mesh | null = null;
  if (rng.chance(0.8)) {
    ring = new THREE.Mesh(new THREE.TorusGeometry(def.radius * 0.72, def.radius * 0.09, 10, 36), hull);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    // spokes
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(def.radius * 0.03, def.radius * 0.03, def.radius * 1.44, 6), dark);
      spoke.rotation.z = Math.PI / 2;
      spoke.rotation.y = (i / 4) * Math.PI;
      ring.add(spoke);
    }
  }

  // stacked modules along the spine
  const mods = rng.int(3, 6);
  for (let i = 0; i < mods; i++) {
    const y = rng.range(-0.7, 0.7) * spineLen * 0.5;
    const kind = rng.next();
    let m: THREE.Mesh;
    if (kind < 0.5) {
      m = new THREE.Mesh(new THREE.BoxGeometry(rng.range(0.2, 0.5) * def.radius, rng.range(0.1, 0.25) * def.radius, rng.range(0.2, 0.5) * def.radius), hull);
    } else {
      m = new THREE.Mesh(new THREE.CylinderGeometry(rng.range(0.1, 0.3) * def.radius, rng.range(0.1, 0.3) * def.radius, rng.range(0.15, 0.4) * def.radius, 8), hull);
    }
    m.position.set(rng.range(-0.1, 0.1) * def.radius, y, rng.range(-0.1, 0.1) * def.radius);
    m.rotation.y = rng.range(0, Math.PI);
    group.add(m);
  }

  // docking arms with approach lights
  const blinkers: THREE.Mesh[] = [];
  const arms = rng.int(2, 3);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng.range(0, 0.6);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(def.radius * 0.5, def.radius * 0.05, def.radius * 0.08), dark);
    arm.position.set(Math.cos(a) * def.radius * 0.45, rng.range(-0.3, 0.3) * def.radius, Math.sin(a) * def.radius * 0.45);
    arm.rotation.y = -a;
    group.add(arm);
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(def.radius * 0.025, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3322 }),
    );
    tip.position.set(Math.cos(a) * def.radius * 0.72, arm.position.y, Math.sin(a) * def.radius * 0.72);
    group.add(tip);
    blinkers.push(tip);
  }

  // antennae
  for (let i = 0; i < rng.int(2, 4); i++) {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, def.radius * rng.range(0.5, 1.0), 4), dark);
    ant.position.set(rng.range(-0.2, 0.2) * def.radius, (rng.chance(0.5) ? 1 : -1) * spineLen * 0.55, rng.range(-0.2, 0.2) * def.radius);
    group.add(ant);
  }

  group.rotation.y = rng.range(0, Math.PI * 2);
  return { group, ring, blinkers };
}

// ---------------------------------------------------------------------------

export class BodiesLayer {
  stations: StationView[] = [];
  private planetMeshes: { def: PlanetDef; mesh: THREE.Mesh }[] = [];
  private starMesh: THREE.Group;

  constructor(private sm: SceneManager, system: SystemDef) {
    // star
    this.starMesh = new THREE.Group();
    const starR = system.starRadius * FAR_SCALE;
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(starR, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xffc070 }),
    );
    this.starMesh.add(core);
    this.starMesh.add(glowSprite('rgb(255,176,80)', starR * 9));
    sm.far.add(this.starMesh);

    // planets + moons
    for (const p of system.planets) {
      const tex = planetTexture(p);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(p.radius * FAR_SCALE, 48, 24),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 }),
      );
      if (p.kind !== 'barren' && p.kind !== 'rocky') {
        const atmoColor = p.kind === 'lava' ? new THREE.Color(0xcc4422)
          : p.kind === 'gas' ? new THREE.Color(0xcc9966)
            : p.kind === 'ice' ? new THREE.Color(0x88bbdd) : new THREE.Color(0x6699cc);
        const atmo = new THREE.Mesh(new THREE.SphereGeometry(p.radius * FAR_SCALE * 1.04, 48, 24), atmosphereMaterial(atmoColor));
        mesh.add(atmo);
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
      const { group, ring, blinkers } = buildStationMesh(def);
      group.visible = false;
      sm.near.add(group);
      const marker = new THREE.Group();
      const beacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(2.2),
        new THREE.MeshBasicMaterial({ color: 0x99ccee }),
      );
      marker.add(beacon, glowSprite('rgb(150,200,235)', 14));
      sm.far.add(marker);
      this.stations.push({ def, group, ring, blinkers, marker });
    }
  }

  update(time: number): void {
    const sm = this.sm;
    this.starMesh.position.copy(sm.toFar({ x: 0, y: 0, z: 0 }, tmp));
    for (const { def, mesh } of this.planetMeshes) {
      mesh.position.copy(sm.toFar(def.pos, tmp));
      mesh.rotation.y = time * 0.005;
    }
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
      } else {
        sv.marker.position.copy(sm.toFar(sv.def.pos, tmp));
      }
    }
  }
}
