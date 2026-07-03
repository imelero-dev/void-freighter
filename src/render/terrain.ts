// Near-scene planetary terrain (#16): when the ship gets low over a solid
// body, sample the sim's surfaceRadius() — the same function collision uses —
// into a local grid mesh, so what you see is exactly what you can hit (#21).
// Also renders the surface-port landing pads (#17) and an atmosphere sky
// dome that fades the stars out during descent.

import * as THREE from 'three';
import { surfaceEnvAt, surfaceRadius, type SurfaceBody } from '../sim/surface';
import { v3, vadd, vcross, vlen, vnorm, vscale, vsub, type Vec3 } from '../sim/vec';
import type { IWorld } from '../world_api';
import { SceneManager } from './scene';

const GRID = 56;                 // GRID×GRID quads per patch
const REBUILD_MOVE_FRAC = 0.12;  // rebuild when the anchor drifts this × extent

const KIND_COLORS: Record<string, [THREE.Color, THREE.Color]> = {
  // [low, high] altitude tint
  lava: [new THREE.Color(0x2a1512), new THREE.Color(0x6b3226)],
  rocky: [new THREE.Color(0x4a4038), new THREE.Color(0x8a7a66)],
  terran: [new THREE.Color(0x27404a), new THREE.Color(0x5d7040)],
  ice: [new THREE.Color(0x9fb6bd), new THREE.Color(0xdfeef2)],
  barren: [new THREE.Color(0x4f4b45), new THREE.Color(0x7d766c)],
  moon: [new THREE.Color(0x494a4e), new THREE.Color(0x84868c)],
};

const SKY_COLORS: Record<string, THREE.Color> = {
  lava: new THREE.Color(0x381410),
  rocky: new THREE.Color(0x27201a),
  terran: new THREE.Color(0x33506b),
  ice: new THREE.Color(0x40566b),
  barren: new THREE.Color(0x181614),
  moon: new THREE.Color(0x000000),
  gas: new THREE.Color(0x4a3623),
};

export class TerrainLayer {
  private mesh: THREE.Mesh | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private anchor: Vec3 = v3();       // world-space patch center
  private extent = 0;
  private bodyId = '';
  private sky: THREE.Mesh;
  private skyMat: THREE.MeshBasicMaterial;
  private padGroups = new Map<string, THREE.Group>(); // bodyId -> pads
  private tmp = new THREE.Vector3();

  constructor(private sm: SceneManager, private world: IWorld) {
    // inverted dome glued to the camera: fades stars/void out in atmosphere
    this.skyMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(55_000, 24, 12), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.visible = false;
    sm.near.add(this.sky);
  }

  update(): void {
    const { sm, world } = this;
    const pos = sm.origin; // camera ≈ ship
    const env = surfaceEnvAt(world.surfaceBodies, pos);

    // sky tint from atmosphere density
    if (env && env.density > 0.01) {
      this.sky.visible = true;
      this.sky.position.set(0, 0, 0);
      this.skyMat.color.copy(SKY_COLORS[env.body.kind] ?? SKY_COLORS.rocky);
      this.skyMat.opacity = Math.min(0.94, env.density * 1.1);
    } else {
      this.sky.visible = false;
    }

    if (!env || !env.body.solid || env.altitude > 45_000) {
      if (this.mesh) this.mesh.visible = false;
      for (const g of this.padGroups.values()) g.visible = false;
      return;
    }

    const body = env.body;
    const wantExtent = Math.min(80_000, Math.max(6000, env.altitude * 5 + 4000));
    const groundPoint = vadd(body.pos, vscale(env.up, env.surfR));
    const moved = this.mesh ? vlen(vsub(groundPoint, this.anchor)) : Infinity;
    if (this.bodyId !== body.id || !this.mesh
      || moved > this.extent * REBUILD_MOVE_FRAC
      || wantExtent > this.extent * 1.5 || wantExtent < this.extent / 1.5) {
      this.rebuild(body, groundPoint, wantExtent);
    }
    if (this.mesh) {
      this.mesh.visible = true;
      this.mesh.position.set(
        this.anchor.x - sm.origin.x,
        this.anchor.y - sm.origin.y,
        this.anchor.z - sm.origin.z,
      );
    }

    // landing pads
    if (body.pads.length > 0 && env.altitude < 30_000) {
      let g = this.padGroups.get(body.id);
      if (!g) {
        g = buildPads(body);
        this.padGroups.set(body.id, g);
        sm.near.add(g);
      }
      g.visible = true;
      // group children are positioned relative to the first pad
      const p0 = body.pads[0].pos;
      g.position.set(p0.x - sm.origin.x, p0.y - sm.origin.y, p0.z - sm.origin.z);
      const blink = Math.sin(performance.now() / 260) > 0;
      g.traverse((node) => {
        if (node.userData.blinker) node.visible = blink;
      });
    } else {
      const g = this.padGroups.get(body.id);
      if (g) g.visible = false;
    }
  }

  private rebuild(body: SurfaceBody, groundPoint: Vec3, extent: number): void {
    this.bodyId = body.id;
    this.anchor = groundPoint;
    this.extent = extent;
    const up = vnorm(vsub(groundPoint, body.pos));
    let t1 = vcross(up, v3(0, 1, 0));
    if (vlen(t1) < 1e-6) t1 = vcross(up, v3(1, 0, 0));
    t1 = vnorm(t1);
    const t2 = vnorm(vcross(up, t1));

    const n = GRID + 1;
    const positions = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const [lowC, highC] = KIND_COLORS[body.kind] ?? KIND_COLORS.rocky;
    const c = new THREE.Color();
    let vi = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const ox = (i / GRID - 0.5) * extent;
        const oy = (j / GRID - 0.5) * extent;
        const probe = vadd(groundPoint, vadd(vscale(t1, ox), vscale(t2, oy)));
        const dir = vnorm(vsub(probe, body.pos));
        const r = surfaceRadius(body, dir);
        const world = vadd(body.pos, vscale(dir, r));
        positions[vi * 3] = world.x - groundPoint.x;
        positions[vi * 3 + 1] = world.y - groundPoint.y;
        positions[vi * 3 + 2] = world.z - groundPoint.z;
        // height-tinted color with a little deterministic patchiness
        const hFrac = Math.max(0, Math.min(1, (r - body.radius) / Math.max(1, body.radius * 0.012) * 0.5 + 0.5));
        c.copy(lowC).lerp(highC, hFrac);
        const grain = 0.9 + ((i * 7 + j * 13) % 5) * 0.04;
        colors[vi * 3] = c.r * grain;
        colors[vi * 3 + 1] = c.g * grain;
        colors[vi * 3 + 2] = c.b * grain;
        vi++;
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
        indices.push(a, d, b, b, d, e);
      }
    }
    if (!this.geo) {
      this.geo = new THREE.BufferGeometry();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.96, metalness: 0.04, flatShading: true,
      });
      this.mesh = new THREE.Mesh(this.geo, mat);
      this.sm.near.add(this.mesh);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geo.setIndex(indices);
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }
}

// Landing pads: dark octagonal decks with blinking edge lights and a lit
// number board — built once per body, positioned relative to pad[0].
function buildPads(body: SurfaceBody): THREE.Group {
  const group = new THREE.Group();
  const p0 = body.pads[0].pos;
  for (const pad of body.pads) {
    const padG = new THREE.Group();
    const deck = new THREE.Mesh(
      new THREE.CylinderGeometry(pad.radius, pad.radius * 1.12, 2.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x2e3134, roughness: 0.85, metalness: 0.5 }),
    );
    padG.add(deck);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(pad.radius * 0.92, 0.7, 6, 24),
      new THREE.MeshBasicMaterial({ color: 0x2f6b3a }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 1.6;
    padG.add(rim);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const light = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x54e07a }),
      );
      light.position.set(Math.cos(a) * pad.radius, 2.2, Math.sin(a) * pad.radius);
      light.userData.blinker = i % 2 === 0;
      padG.add(light);
    }
    // number board
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a0c0e';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#d9a441';
    ctx.font = 'bold 44px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pad.name.split(' ')[1] ?? '?', 32, 34);
    const tex = new THREE.CanvasTexture(canvas);
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    );
    board.rotation.x = -Math.PI / 2;
    board.position.y = 1.5;
    padG.add(board);

    // orient deck up along the pad normal, position relative to pad[0]
    padG.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(pad.up.x, pad.up.y, pad.up.z));
    padG.position.set(pad.pos.x - p0.x, pad.pos.y - p0.y, pad.pos.z - p0.z);
    group.add(padG);
  }
  return group;
}
