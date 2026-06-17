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
  kind: 'beam' | 'flash' | 'explosion' | 'sparks' | 'ring';
  grow?: number; // ring: final scale multiple relative to start
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

// annulus texture for shield ripples (a bright ring, hollow centre)
function ringTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0)');
  g.addColorStop(0.82, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

let glowTex: THREE.Texture | null = null;
let ringTex: THREE.Texture | null = null;

export class FxLayer {
  private effects: Effect[] = [];
  private beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 5, 1, true);

  // persistent player mining beam: driven every frame from the latest aimed
  // rock so it reads as one continuous cutting beam, not a stutter of flashes
  private miningBeam: THREE.Mesh | null = null;
  private miningGlow: THREE.Sprite | null = null;
  private miningTarget = new THREE.Vector3();
  private miningHit = false;
  private miningAt = -1;       // perf.now() of the last player mining tick
  private sparkAcc = 0;
  private tmpFrom = new THREE.Vector3();
  private tmpTo = new THREE.Vector3();

  constructor(private sm: SceneManager, private world: IWorld, private entities: EntitiesLayer) {
    if (!glowTex) glowTex = glowTexture();
    if (!ringTex) ringTex = ringTexture();
  }

  handleEvents(events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'laser': {
          // the local player's mining beam is rendered as a persistent object
          // updated per frame (see updateMiningBeam) — record the contact and
          // skip the transient flash-beam so the two don't fight
          if (ev.mining && ev.fromId === this.world.playerId) {
            this.miningTarget.set(ev.toX, ev.toY, ev.toZ);
            this.miningHit = ev.hit;
            this.miningAt = performance.now();
            break;
          }
          const from = this.entities.objectFor(ev.fromId);
          let fromPos: THREE.Vector3 | null = null;
          if (from && from.visible) {
            fromPos = from.position.clone();
          } else if (ev.fromId === this.world.playerId) {
            // first person: the own hull is hidden and the camera sits at the
            // scene origin — a beam starting exactly at the eye is collinear
            // with the view axis and projects to an invisible dot. Originate
            // it at the hull emitter below the cockpit instead.
            fromPos = new THREE.Vector3(0, -1.8, -1).applyQuaternion(this.sm.camera.quaternion);
          }
          if (!fromPos) break;
          const to = new THREE.Vector3(ev.toX - this.sm.origin.x, ev.toY - this.sm.origin.y, ev.toZ - this.sm.origin.z);
          this.spawnBeam(fromPos, to, ev.mining ? 0xffa030 : 0xff4040, ev.mining ? 0.1 : 0.085, ev.mining ? 0.45 : 0.55);
          if (ev.hit) this.spawnFlash(to, ev.mining ? 0xffaa44 : 0xff6666, ev.mining ? 4 : 6, 0.18);
          break;
        }
        case 'hit': {
          const p = new THREE.Vector3(ev.x - this.sm.origin.x, ev.y - this.sm.origin.y, ev.z - this.sm.origin.z);
          if (ev.amount > 0) {
            if (ev.shield) {
              // shield impact: a blue ripple ring + soft flash; a collapsing
              // shield throws a much bigger ring
              this.spawnRipple(p, 0x6cb6ff, ev.broke ? 30 : 16);
              this.spawnFlash(p, 0x66aaff, ev.broke ? 18 : 12, ev.broke ? 0.4 : 0.22);
            } else {
              // bare hull: hot orange sparks shower off the plating
              this.spawnHullSparks(p);
              this.spawnFlash(p, 0xffaa55, 9, 0.22);
            }
          } else {
            this.spawnFlash(p, 0x997755, 4, 0.12); // bolt soaked by a rock
          }
          break;
        }
        case 'shot': {
          // muzzle flash: a punchy double pop (hot core + warm halo) so firing
          // has visible weight (#12)
          const p = new THREE.Vector3(ev.x - this.sm.origin.x, ev.y - this.sm.origin.y, ev.z - this.sm.origin.z);
          this.spawnFlash(p, 0xffe0a0, 5, 0.09);
          this.spawnFlash(p, 0xff8a3a, 9, 0.06);
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

  // expanding shield ripple: a camera-facing ring that grows and fades
  private spawnRipple(p: THREE.Vector3, color: number, finalSize: number): void {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTex!, color, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sprite.position.copy(p);
    const start = finalSize * 0.3;
    sprite.scale.set(start, start, 1);
    this.sm.near.add(sprite);
    this.effects.push({ obj: sprite, ttl: 0.4, life: 0.4, kind: 'ring', grow: finalSize / start });
  }

  // hot sparks shed off bare hull plating on a kinetic hit
  private spawnHullSparks(p: THREE.Vector3): void {
    const count = 10;
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      velocities.push(new THREE.Vector3(
        Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5,
      ).normalize().multiplyScalar(14 + Math.random() * 40));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffb347, size: 2.0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.userData.velocities = velocities;
    this.sm.near.add(points);
    this.effects.push({ obj: points, ttl: 0.45, life: 0.45, kind: 'sparks' });
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

  // Continuous mining beam: a fat, gently pulsing additive cylinder from the
  // ship's emitter to the rock, a bright contact glow, and a steady shower of
  // sparks at the impact point. Rebuilt every frame so it stays glued to the
  // moving floating origin.
  private updateMiningBeam(dt: number): void {
    const active = this.world.miningBeamOn && this.miningHit
      && performance.now() - this.miningAt < 200;
    if (!active) {
      if (this.miningBeam) this.miningBeam.visible = false;
      if (this.miningGlow) this.miningGlow.visible = false;
      return;
    }
    // lazy-build the persistent objects on first use
    if (!this.miningBeam) {
      this.miningBeam = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({
        color: 0xffb347, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.sm.near.add(this.miningBeam);
    }
    if (!this.miningGlow) {
      this.miningGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex!, color: 0xffd27a, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.sm.near.add(this.miningGlow);
    }
    // emitter: the visible hull in chase view, else a fixed point under the
    // cockpit so the beam doesn't degenerate to a dot along the view axis
    const fromObj = this.entities.objectFor(this.world.playerId);
    if (fromObj && fromObj.visible) {
      this.tmpFrom.copy(fromObj.position);
    } else {
      this.tmpFrom.set(0, -1.8, -1).applyQuaternion(this.sm.camera.quaternion);
    }
    this.tmpTo.set(
      this.miningTarget.x - this.sm.origin.x,
      this.miningTarget.y - this.sm.origin.y,
      this.miningTarget.z - this.sm.origin.z,
    );
    const len = this.tmpFrom.distanceTo(this.tmpTo);
    if (len < 1 || len > 80_000) {
      this.miningBeam.visible = false;
      this.miningGlow.visible = false;
      return;
    }
    const pulse = 0.85 + Math.sin(performance.now() / 45) * 0.15;
    this.miningBeam.visible = true;
    this.miningBeam.scale.set(1.6 * pulse, len, 1.6 * pulse);
    this.miningBeam.position.copy(this.tmpFrom).lerp(this.tmpTo, 0.5);
    this.miningBeam.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), this.tmpTo.clone().sub(this.tmpFrom).normalize());
    (this.miningBeam.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.25 * pulse;
    this.miningGlow.visible = true;
    this.miningGlow.position.copy(this.tmpTo);
    this.miningGlow.scale.setScalar(7 + Math.sin(performance.now() / 60) * 1.5);

    // continuous spark shower at the contact point (throttled, capped count)
    this.sparkAcc += dt;
    if (this.sparkAcc >= 0.045) {
      this.sparkAcc = 0;
      this.spawnMiningSparks(this.tmpTo);
    }
  }

  private spawnMiningSparks(p: THREE.Vector3): void {
    const count = 6;
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      velocities.push(new THREE.Vector3(
        Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5,
      ).normalize().multiplyScalar(8 + Math.random() * 26));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffc04a, size: 1.7, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.userData.velocities = velocities;
    this.sm.near.add(points);
    this.effects.push({ obj: points, ttl: 0.32, life: 0.32, kind: 'sparks' });
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
      } else if (fx.kind === 'ring') {
        // ease-out growth + fade for the shield ripple
        const sprite = fx.obj as THREE.Sprite;
        const start = (sprite.userData.startScale ??= sprite.scale.x);
        const prog = 1 - t;                 // 0 -> 1 over the effect's life
        const ease = 1 - (1 - prog) * (1 - prog);
        const s = start * (1 + (fx.grow! - 1) * ease);
        sprite.scale.set(s, s, 1);
        (sprite.material as THREE.SpriteMaterial).opacity = t * 0.85;
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
