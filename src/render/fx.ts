// Transient combat/mining FX driven by SimEvents: beams, flashes, explosions.

import * as THREE from 'three';
import { qrot } from '../sim/vec';
import type { SimEvent } from '../sim/types';
import type { IWorld } from '../world_api';
import { SceneManager } from './scene';
import type { EntitiesLayer } from './entities';

interface Effect {
  obj: THREE.Object3D;
  ttl: number;
  life: number;
  kind: 'beam' | 'flash' | 'explosion' | 'sparks' | 'ripple';
  baseSize?: number; // ripple: starting scale
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

  // sustained mining beam (#10): one persistent beam + impact glow driven by
  // the 50 ms laser-event stream, world-anchored so the floating origin and
  // the ship's own motion don't smear it
  private mineBeam: THREE.Mesh | null = null;
  private mineGlow: THREE.Sprite | null = null;
  private mineUntil = 0;          // seconds of beam life left (refreshed by events)
  private mineFromId = 0;
  private mineToW = new THREE.Vector3(); // impact point, world coords
  private sparkAcc = 0;

  constructor(private sm: SceneManager, private world: IWorld, private entities: EntitiesLayer) {
    if (!glowTex) glowTex = glowTexture();
  }

  handleEvents(events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'laser': {
          if (ev.mining) {
            // feed the sustained beam instead of stuttering one-shot flashes
            this.mineFromId = ev.fromId;
            this.mineToW.set(ev.toX, ev.toY, ev.toZ);
            this.mineUntil = 0.22;
            break;
          }
          const from = this.entities.objectFor(ev.fromId);
          const fromPos = from && from.visible ? from.position.clone()
            : ev.fromId === this.world.playerId ? new THREE.Vector3(0, 0, 0) : null;
          if (!fromPos) break;
          const to = new THREE.Vector3(ev.toX - this.sm.origin.x, ev.toY - this.sm.origin.y, ev.toZ - this.sm.origin.z);
          this.spawnBeam(fromPos, to, 0xff4040, 0.085, 0.55);
          if (ev.hit) this.spawnFlash(to, 0xff6666, 6, 0.18);
          break;
        }
        case 'hit': {
          const p = new THREE.Vector3(ev.x - this.sm.origin.x, ev.y - this.sm.origin.y, ev.z - this.sm.origin.z);
          if (ev.amount > 0) {
            if (ev.shield) {
              // energy splash: blue flash + expanding ripple ring (#12)
              this.spawnFlash(p, 0x66aaff, 12, 0.2);
              this.spawnRipple(p, 0x88bbff, 6, 0.45);
            } else {
              // bare metal: orange flash + hot spark spray (#12)
              this.spawnFlash(p, 0xffaa55, 9, 0.22);
              this.spawnSparks(p, 0xffa050, 8, 42, 0.5);
            }
          } else {
            this.spawnFlash(p, 0x997755, 4, 0.12); // bolt soaked by a rock
          }
          break;
        }
        case 'shieldDown': {
          // the bubble pops: big flash + double ripple collapsing outward
          const p = new THREE.Vector3(ev.x - this.sm.origin.x, ev.y - this.sm.origin.y, ev.z - this.sm.origin.z);
          this.spawnFlash(p, 0xaaddff, 26, 0.4);
          this.spawnRipple(p, 0x99ccff, 8, 0.7);
          this.spawnRipple(p, 0x6699ff, 14, 0.9);
          this.spawnSparks(p, 0x99bbff, 14, 55, 0.7);
          break;
        }
        case 'shot': {
          // muzzle flash with real presence
          const p = new THREE.Vector3(ev.x - this.sm.origin.x, ev.y - this.sm.origin.y, ev.z - this.sm.origin.z);
          this.spawnFlash(p, 0xffbb66, 6, 0.06);
          this.spawnFlash(p, 0xffffff, 2.5, 0.04);
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

  // expanding energy ring (shield splash / shield collapse)
  private spawnRipple(p: THREE.Vector3, color: number, size: number, ttl: number): void {
    const mat = new THREE.SpriteMaterial({
      map: glowTex!, color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(p);
    sprite.scale.set(size, size, 1);
    this.sm.near.add(sprite);
    this.effects.push({ obj: sprite, ttl, life: ttl, kind: 'ripple', baseSize: size });
  }

  // small burst of glowing chips/dust flying off a point (mining impact)
  private spawnSparks(p: THREE.Vector3, color: number, count: number, speed: number, ttl: number): void {
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      velocities.push(new THREE.Vector3(
        (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5),
      ).normalize().multiplyScalar((0.3 + Math.random() * 0.7) * speed));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color, size: 1.4, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.userData.velocities = velocities;
    this.sm.near.add(points);
    this.effects.push({ obj: points, ttl, life: ttl, kind: 'sparks' });
  }

  // Sustained mining beam: recomputed every frame from live world positions.
  private updateMiningBeam(dt: number): void {
    if (this.mineUntil <= 0) {
      if (this.mineBeam) this.mineBeam.visible = false;
      if (this.mineGlow) this.mineGlow.visible = false;
      return;
    }
    this.mineUntil -= dt;
    if (!this.mineBeam) {
      this.mineBeam = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({
        color: 0xffa030, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.sm.near.add(this.mineBeam);
      this.mineGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex!, color: 0xffbb55, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.sm.near.add(this.mineGlow);
    }
    // beam start: fresh emitter position each frame (wing hardpoint, not the
    // camera origin — a camera-origin beam is invisible in first person)
    const ship = this.mineFromId === this.world.playerId
      ? this.world.player
      : this.world.entities.get(this.mineFromId) ?? null;
    if (!ship) {
      this.mineUntil = 0;
      return;
    }
    const emitter = qrot(ship.orient, { x: 2.2, y: -1.6, z: -ship.radius * 0.4 });
    const a = new THREE.Vector3(
      ship.pos.x + emitter.x - this.sm.origin.x,
      ship.pos.y + emitter.y - this.sm.origin.y,
      ship.pos.z + emitter.z - this.sm.origin.z,
    );
    const b = new THREE.Vector3(
      this.mineToW.x - this.sm.origin.x,
      this.mineToW.y - this.sm.origin.y,
      this.mineToW.z - this.sm.origin.z,
    );
    const len = a.distanceTo(b);
    if (len < 1 || len > 5000) {
      this.mineBeam.visible = false;
      if (this.mineGlow) this.mineGlow.visible = false;
      return;
    }
    const pulse = 0.85 + Math.sin(performance.now() / 45) * 0.25;
    this.mineBeam.visible = true;
    this.mineBeam.scale.set(1.6 * pulse, len, 1.6 * pulse);
    this.mineBeam.position.copy(a).lerp(b, 0.5);
    this.mineBeam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    (this.mineBeam.material as THREE.MeshBasicMaterial).opacity = 0.55 + pulse * 0.3;
    this.mineGlow!.visible = true;
    this.mineGlow!.position.copy(b);
    this.mineGlow!.scale.setScalar(5 + pulse * 4);

    // continuous cutting sparks at the contact point
    this.sparkAcc += dt;
    while (this.sparkAcc > 0.06) {
      this.sparkAcc -= 0.06;
      this.spawnSparks(b, 0xffb060, 5, 26, 0.55);
      if (Math.random() < 0.3) this.spawnSparks(b, 0xd8d0c0, 3, 12, 0.9); // slower rock dust
    }
  }

  update(dt: number): void {
    this.updateMiningBeam(dt);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.ttl -= dt;
      const t = Math.max(0, fx.ttl / fx.life);
      if (fx.kind === 'beam' || fx.kind === 'flash') {
        const mat = (fx.obj as THREE.Mesh | THREE.Sprite).material as THREE.Material & { opacity: number };
        mat.opacity = t * 0.9;
      } else if (fx.kind === 'ripple') {
        const sprite = fx.obj as THREE.Sprite;
        const grow = 1 - t; // 0 -> 1 over life
        const s = (fx.baseSize ?? 6) * (1 + grow * 4);
        sprite.scale.set(s, s, 1);
        (sprite.material as THREE.SpriteMaterial).opacity = t * 0.7;
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
