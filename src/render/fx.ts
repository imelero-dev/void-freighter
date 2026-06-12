// Transient combat/mining FX driven by SimEvents: beams, flashes, explosions.

import * as THREE from 'three';
import type { SimEvent } from '../sim/types';
import type { IWorld } from '../world_api';
import { SceneManager } from './scene';
import type { EntitiesLayer } from './entities';

interface Effect {
  obj: THREE.Object3D;
  ttl: number;
  life: number;
  kind: 'beam' | 'flash' | 'explosion' | 'sparks';
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

let glowTex: THREE.Texture | null = null;

export class FxLayer {
  private effects: Effect[] = [];
  private beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 5, 1, true);

  constructor(private sm: SceneManager, private world: IWorld, private entities: EntitiesLayer) {
    if (!glowTex) glowTex = glowTexture();
  }

  handleEvents(events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'laser': {
          const from = this.entities.objectFor(ev.fromId);
          const fromPos = from && from.visible ? from.position.clone()
            : ev.fromId === this.world.playerId ? new THREE.Vector3(0, 0, 0) : null;
          if (!fromPos) break;
          const to = new THREE.Vector3(ev.toX - this.sm.origin.x, ev.toY - this.sm.origin.y, ev.toZ - this.sm.origin.z);
          this.spawnBeam(fromPos, to, ev.mining ? 0xffa030 : 0xff4040, ev.mining ? 0.1 : 0.085, ev.mining ? 0.7 : 0.55);
          if (ev.hit) this.spawnFlash(to, ev.mining ? 0xffaa44 : 0xff6666, ev.mining ? 4 : 6, 0.18);
          break;
        }
        case 'hit': {
          const p = new THREE.Vector3(ev.x - this.sm.origin.x, ev.y - this.sm.origin.y, ev.z - this.sm.origin.z);
          this.spawnFlash(p, ev.shield ? 0x66aaff : 0xffaa55, ev.shield ? 14 : 9, 0.25);
          break;
        }
        case 'explosion': {
          const p = new THREE.Vector3(ev.x - this.sm.origin.x, ev.y - this.sm.origin.y, ev.z - this.sm.origin.z);
          this.spawnExplosion(p, ev.big);
          break;
        }
      }
    }
  }

  private spawnBeam(a: THREE.Vector3, b: THREE.Vector3, color: number, radius: number, ttl: number): void {
    const len = a.distanceTo(b);
    if (len < 1 || len > 80_000) return;
    const mesh = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    mesh.scale.set(radius * 14, len, radius * 14);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    this.sm.near.add(mesh);
    this.effects.push({ obj: mesh, ttl, life: ttl, kind: 'beam' });
  }

  private spawnFlash(p: THREE.Vector3, color: number, size: number, ttl: number): void {
    const mat = new THREE.SpriteMaterial({
      map: glowTex!, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(p);
    sprite.scale.set(size, size, 1);
    this.sm.near.add(sprite);
    this.effects.push({ obj: sprite, ttl, life: ttl, kind: 'flash' });
  }

  private spawnExplosion(p: THREE.Vector3, big: boolean): void {
    const size = big ? 60 : 18;
    this.spawnFlash(p, 0xffcc88, size, 0.5);
    this.spawnFlash(p, 0xff6622, size * 0.6, 0.8);
    // debris points
    const count = big ? 60 : 20;
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      velocities.push(new THREE.Vector3(
        (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5),
      ).normalize().multiplyScalar(Math.random() * (big ? 90 : 45)));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffaa66, size: big ? 2.4 : 1.6, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.userData.velocities = velocities;
    this.sm.near.add(points);
    const ttl = big ? 1.6 : 0.9;
    this.effects.push({ obj: points, ttl, life: ttl, kind: 'sparks' });
  }

  update(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.ttl -= dt;
      const t = Math.max(0, fx.ttl / fx.life);
      if (fx.kind === 'beam' || fx.kind === 'flash') {
        const mat = (fx.obj as THREE.Mesh | THREE.Sprite).material as THREE.Material & { opacity: number };
        mat.opacity = t * 0.9;
      } else if (fx.kind === 'sparks') {
        const points = fx.obj as THREE.Points;
        const pos = points.geometry.attributes.position;
        const vels: THREE.Vector3[] = points.userData.velocities;
        for (let j = 0; j < vels.length; j++) {
          pos.setXYZ(j, pos.getX(j) + vels[j].x * dt, pos.getY(j) + vels[j].y * dt, pos.getZ(j) + vels[j].z * dt);
        }
        pos.needsUpdate = true;
        (points.material as THREE.PointsMaterial).opacity = t;
      }
      if (fx.ttl <= 0) {
        this.sm.near.remove(fx.obj);
        // beams share beamGeo; sparks own their geometry — materials are
        // always per-effect
        const obj = fx.obj as THREE.Mesh | THREE.Sprite | THREE.Points;
        if (fx.kind === 'sparks') (obj as THREE.Points).geometry.dispose();
        (obj.material as THREE.Material)?.dispose();
        this.effects.splice(i, 1);
      }
    }
  }
}
