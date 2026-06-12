// Flight HUD: a single full-screen canvas drawn every frame. Amber-on-black
// instrument look, deliberately analog and a little dirty.

import * as THREE from 'three';
import { GOODS } from '../sim/data';
import type { Entity } from '../sim/types';
import { qForward, vdist, vlen, vsub, vnorm, vdot } from '../sim/vec';
import type { IWorld } from '../world_api';
import { fmtDistance, fmtTime } from './dom';

const AMBER = '#d9a441';
const AMBER_DIM = 'rgba(217, 164, 65, 0.45)';
const RED = '#e8402a';
const CYAN = '#7fb1c9';
const GRAY = '#8a8d90';
const GREEN = '#7fc97f';

export interface LogLine {
  text: string;
  color: string;
  at: number; // performance.now ms
}

export class Hud {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  log: LogLine[] = [];
  comms: { text: string; at: number } | null = null;
  alert: { text: string; color: string; until: number } | null = null;
  cameraMode: 'cockpit' | 'chase' = 'cockpit';
  destAligned = false; // exposed so the app can play the snap tone on change

  private proj = new THREE.Vector3();
  private floaters: Array<{ pos: { x: number; y: number; z: number }; text: string; color: string; at: number }> = [];

  constructor(private camera: THREE.PerspectiveCamera) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  pushLog(text: string, color = AMBER): void {
    this.log.push({ text, color, at: performance.now() });
    if (this.log.length > 8) this.log.shift();
  }

  setComms(text: string): void {
    this.comms = { text, at: performance.now() };
  }

  flashAlert(text: string, color = RED, durationMs = 2600): void {
    this.alert = { text, color, until: performance.now() + durationMs };
  }

  // floating combat text anchored to a world position
  pushFloater(pos: { x: number; y: number; z: number }, text: string, color: string): void {
    this.floaters.push({ pos, text, color, at: performance.now() });
    if (this.floaters.length > 24) this.floaters.shift();
  }

  resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  // project a world-relative (near-scene local) position to screen px; returns
  // null if behind the camera
  private toScreen(local: THREE.Vector3): { x: number; y: number; behind: boolean } {
    this.proj.copy(local).project(this.camera);
    const behind = this.proj.z > 1;
    return {
      x: (this.proj.x * 0.5 + 0.5) * this.canvas.width,
      y: (-this.proj.y * 0.5 + 0.5) * this.canvas.height,
      behind,
    };
  }

  draw(world: IWorld, origin: { x: number; y: number; z: number }, cursorX: number, cursorY: number, uiMode: boolean): void {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const ship = world.player;
    if (!ship) return;
    const now = performance.now();
    ctx.font = '12px "Lucida Console", monospace';
    ctx.textBaseline = 'middle';

    if (ship.dockedAt) {
      this.drawLog(now, W, H);
      return; // station UI takes over
    }

    const cx = W / 2, cy = H / 2;
    const stats = world.shipStats;

    // ---- cockpit frame ----
    if (this.cameraMode === 'cockpit') {
      ctx.strokeStyle = 'rgba(20, 22, 25, 0.9)';
      ctx.lineWidth = Math.max(26, W * 0.02);
      ctx.beginPath();
      ctx.moveTo(-10, H * 0.72);
      ctx.lineTo(W * 0.3, H + 30);
      ctx.moveTo(W + 10, H * 0.72);
      ctx.lineTo(W * 0.7, H + 30);
      ctx.stroke();
    }

    // ---- reticle ----
    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 38, cy);
    ctx.lineTo(cx - 28, cy);
    ctx.moveTo(cx + 28, cy);
    ctx.lineTo(cx + 38, cy);
    ctx.moveTo(cx, cy - 38);
    ctx.lineTo(cx, cy - 28);
    ctx.moveTo(cx, cy + 28);
    ctx.lineTo(cx, cy + 38);
    ctx.stroke();

    // virtual cursor
    if (!uiMode) {
      const px = cx + cursorX * Math.min(W, H) * 0.42;
      const py = cy + cursorY * Math.min(W, H) * 0.42;
      ctx.strokeStyle = AMBER;
      ctx.beginPath();
      ctx.moveTo(px - 6, py);
      ctx.lineTo(px + 6, py);
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px, py + 6);
      ctx.stroke();
    }

    // ---- left cluster: speed / throttle / fuel ----
    const speed = vlen(ship.vel);
    const lx = Math.max(60, W * 0.09);
    const ly = cy + 30;
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'left';
    ctx.font = '20px "Lucida Console", monospace';
    ctx.fillText(speed > 10_000 ? `${(speed / 1000).toFixed(1)} km/s` : `${Math.round(speed)} m/s`, lx, ly - 56);
    ctx.font = '11px "Lucida Console", monospace';
    ctx.fillStyle = AMBER_DIM;
    ctx.fillText(ship.cruise === 'cruise' ? 'CRUISE' : ship.cruise === 'charging' ? 'CRUISE CHARGE…' : `THR ${Math.round(ship.throttle * 100)}%`, lx, ly - 38);
    // throttle bar
    this.vbar(lx, ly - 24, 6, 70, Math.abs(ship.throttle), ship.throttle < 0 ? RED : AMBER);
    // fuel
    const fuelFrac = world.profile.fuel / stats.fuelMax;
    this.vbar(lx + 16, ly - 24, 6, 70, fuelFrac, fuelFrac < 0.2 ? RED : CYAN);
    ctx.fillStyle = AMBER_DIM;
    ctx.fillText('THR', lx - 4, ly + 58);
    ctx.fillText('FUE', lx + 12, ly + 58);
    if (fuelFrac < 0.2) {
      ctx.fillStyle = RED;
      ctx.fillText(fuelFrac <= 0.02 ? 'FUEL EMPTY — F1 help' : 'FUEL LOW', lx - 4, ly + 76);
    }
    if (!world.flightAssist) {
      ctx.fillStyle = CYAN;
      ctx.fillText('FA OFF', lx - 4, ly + 92);
    }

    // ---- bottom-center: hull/shield ----
    const bw = 170;
    const bx = cx - bw / 2;
    const by = H - Math.max(72, H * 0.1);
    this.hbar(bx, by, bw, 7, ship.shield / Math.max(1, ship.maxShield), CYAN);
    this.hbar(bx, by + 11, bw, 7, ship.hull / ship.maxHull, ship.hull / ship.maxHull < 0.25 ? RED : AMBER);
    ctx.textAlign = 'center';
    ctx.fillStyle = AMBER_DIM;
    ctx.fillText(`SHD ${Math.round(ship.shield)}/${ship.maxShield}   HUL ${Math.round(ship.hull)}/${ship.maxHull}`, cx, by + 30);
    if (stats.missileAmmoMax > 0) {
      ctx.fillText(`MSL ${ship.missileAmmo}/${stats.missileAmmoMax}`, cx, by + 44);
    }

    // ---- target panel (right) ----
    const target = ship.targetId !== null ? world.entities.get(ship.targetId) : null;
    const rx = W - Math.max(60, W * 0.09);
    ctx.textAlign = 'right';
    if (target && !target.dead) {
      const d = vdist(ship.pos, target.pos);
      ctx.fillStyle = target.pirate ? RED : target.kind === 'asteroid' ? GRAY : CYAN;
      ctx.font = '13px "Lucida Console", monospace';
      ctx.fillText(target.name.toUpperCase(), rx, cy - 60);
      ctx.font = '11px "Lucida Console", monospace';
      ctx.fillStyle = AMBER_DIM;
      ctx.fillText(fmtDistance(d), rx, cy - 44);
      if (target.kind === 'ship') {
        this.hbar(rx - 110, cy - 34, 110, 5, target.shield / Math.max(1, target.maxShield), CYAN);
        this.hbar(rx - 110, cy - 26, 110, 5, target.hull / target.maxHull, AMBER);
        if (stats.missileAmmoMax > 0 && ship.missileAmmo > 0) {
          const lockFrac = ship.lockedOn ? 1 : ship.lockTimer / stats.missileLockTime;
          ctx.fillStyle = ship.lockedOn ? RED : AMBER_DIM;
          ctx.fillText(ship.lockedOn ? 'LOCK ◆' : lockFrac > 0 ? `LOCK ${Math.round(lockFrac * 100)}%` : '', rx, cy - 10);
        }
      } else if (target.kind === 'asteroid' && target.rockYield) {
        this.hbar(rx - 110, cy - 34, 110, 5, target.rockHp / Math.max(1, target.rockMaxHp), GRAY);
        if (stats.compositionScan) {
          let yLine = cy - 16;
          for (const [g, q] of Object.entries(target.rockYield)) {
            if (q <= 0) continue;
            ctx.fillStyle = AMBER_DIM;
            ctx.fillText(`${GOODS[g]?.name ?? g}: ~${Math.round(q)}`, rx, yLine);
            yLine += 14;
          }
        }
      }
      // target bracket in world
      const tl = new THREE.Vector3(target.pos.x - origin.x, target.pos.y - origin.y, target.pos.z - origin.z);
      const s = this.toScreen(tl);
      if (!s.behind) {
        ctx.strokeStyle = target.pirate ? RED : CYAN;
        ctx.lineWidth = 1.2;
        const r = 14;
        ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
      }
    }

    // ---- destination GPS marker ----
    this.drawDestination(world, ship, origin, cx, cy, W, H);

    // ---- floating combat text ----
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const age = (now - f.at) / 1000;
      if (age > 1.1) {
        this.floaters.splice(i, 1);
        continue;
      }
      const local = new THREE.Vector3(f.pos.x - origin.x, f.pos.y - origin.y, f.pos.z - origin.z);
      const s = this.toScreen(local);
      if (s.behind) continue;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.fillStyle = f.color;
      ctx.font = '13px "Lucida Console", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, s.x, s.y - 20 - age * 26);
      ctx.globalAlpha = 1;
    }

    // ---- contact blips in 3D view ----
    this.drawContacts(world, ship, origin);

    // ---- radar ----
    this.drawRadar(world, ship, W, H);

    // ---- docking prompt ----
    const nearStation = world.system.stations.find((s) => vdist(s.pos, ship.pos) < s.dockRadius);
    ctx.textAlign = 'center';
    if (nearStation) {
      const slow = vlen(ship.vel) <= 60;
      ctx.fillStyle = slow ? GREEN : AMBER;
      ctx.font = '13px "Lucida Console", monospace';
      ctx.fillText(slow ? `[SPACE] DOCK — ${nearStation.name}` : `${nearStation.name}: reduce speed to dock (<60 m/s)`, cx, H * 0.2);
    }

    // ---- alert banner ----
    if (this.alert && now < this.alert.until) {
      const blink = Math.sin(now / 120) > -0.3;
      if (blink) {
        ctx.fillStyle = this.alert.color;
        ctx.font = '16px "Lucida Console", monospace';
        ctx.fillText(this.alert.text, cx, H * 0.27);
      }
    }

    // ---- comms ticker ----
    if (this.comms && now - this.comms.at < 9000) {
      const age = (now - this.comms.at) / 1000;
      const chars = Math.floor(age * 28);
      const text = this.comms.text.slice(0, chars);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(150, 170, 160, 0.75)';
      ctx.font = 'italic 12px "Lucida Console", monospace';
      ctx.fillText(`✦ COMMS … ${text}`, cx, H * 0.085);
    }

    this.drawLog(now, W, H);
  }

  private drawDestination(world: IWorld, ship: Entity, origin: { x: number; y: number; z: number }, cx: number, cy: number, W: number, H: number): void {
    const ctx = this.ctx;
    const dest = world.destination;
    this.destAligned = false;
    if (!dest) return;
    const navQ = world.shipStats.navQuality;
    const d = vdist(ship.pos, dest.pos);
    const local = new THREE.Vector3(dest.pos.x - origin.x, dest.pos.y - origin.y, dest.pos.z - origin.z);
    const s = this.toScreen(local);
    const toDest = vnorm(vsub(dest.pos, ship.pos));
    const fwd = qForward(ship.orient);
    const align = vdot(toDest, fwd); // 1 = dead ahead
    const aligned = align > 0.995;
    this.destAligned = aligned;
    const onScreen = !s.behind && s.x > 0 && s.x < W && s.y > 0 && s.y < H;

    if (onScreen) {
      ctx.strokeStyle = aligned ? GREEN : AMBER;
      ctx.lineWidth = 1.4;
      const r = aligned ? 17 : 13;
      ctx.beginPath(); // diamond
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r, s.y);
      ctx.lineTo(s.x, s.y + r);
      ctx.lineTo(s.x - r, s.y);
      ctx.closePath();
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = aligned ? GREEN : AMBER;
      ctx.font = '11px "Lucida Console", monospace';
      ctx.fillText(dest.name.toUpperCase(), s.x, s.y + r + 12);
      ctx.fillStyle = AMBER_DIM;
      ctx.fillText(fmtDistance(d), s.x, s.y + r + 25);
      if (navQ > 0) {
        const closing = vdot(ship.vel, toDest);
        const eta = closing > 5 ? d / closing : Infinity;
        ctx.fillText(`ETA ${fmtTime(eta)}`, s.x, s.y + r + 38);
      }
    } else {
      // off-screen arrow on the reticle ring pointing toward the destination
      const dir2 = new THREE.Vector3(dest.pos.x - origin.x, dest.pos.y - origin.y, dest.pos.z - origin.z)
        .applyQuaternion(this.camera.quaternion.clone().invert());
      const ang = Math.atan2(dir2.x, dir2.y); // screen-space direction (up = +y)
      const ringR = 64;
      const ax = cx + Math.sin(ang) * ringR;
      const ay = cy - Math.cos(ang) * ringR;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = navQ > 0 ? AMBER : GRAY;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 5);
      ctx.lineTo(-6, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.textAlign = 'center';
      ctx.fillStyle = AMBER_DIM;
      ctx.font = '10px "Lucida Console", monospace';
      ctx.fillText(navQ > 0 ? fmtDistance(d) : '— nav degraded —', cx, cy + 92);
    }
  }

  private drawContacts(world: IWorld, ship: Entity, origin: { x: number; y: number; z: number }): void {
    const ctx = this.ctx;
    const stats = world.shipStats;
    for (const e of world.entities.values()) {
      if (e.id === world.playerId || e.dead) continue;
      if (e.kind !== 'ship' && e.kind !== 'loot' && e.kind !== 'fragment') continue;
      const d = vdist(ship.pos, e.pos);
      if (d > stats.sensorRange || d < 80) continue;
      const local = new THREE.Vector3(e.pos.x - origin.x, e.pos.y - origin.y, e.pos.z - origin.z);
      const s = this.toScreen(local);
      if (s.behind) continue;
      const resolved = d < stats.resolveRange;
      if (e.kind === 'ship') {
        if (!resolved) {
          ctx.strokeStyle = GRAY;
          ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
          ctx.fillStyle = GRAY;
          ctx.font = '9px "Lucida Console", monospace';
          ctx.textAlign = 'center';
          ctx.fillText('?', s.x, s.y + 1);
        } else {
          ctx.strokeStyle = e.pirate ? RED : e.isPlayer ? GREEN : CYAN;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y - 6);
          ctx.lineTo(s.x + 6, s.y + 5);
          ctx.lineTo(s.x - 6, s.y + 5);
          ctx.closePath();
          ctx.stroke();
          if (e.isPlayer) {
            ctx.fillStyle = GREEN;
            ctx.font = '10px "Lucida Console", monospace';
            ctx.fillText(e.name, s.x, s.y - 12);
          }
        }
      } else if (d < 2500) {
        ctx.fillStyle = e.kind === 'loot' ? '#d8c46a' : '#9ab3a0';
        ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
      }
    }
  }

  private drawRadar(world: IWorld, ship: Entity, W: number, H: number): void {
    const ctx = this.ctx;
    const R = Math.max(58, Math.min(W, H) * 0.085);
    const rx = W - R - 24, ry = H - R - 24;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(8, 10, 12, 0.65)';
    ctx.beginPath();
    ctx.arc(rx, ry, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rx, ry, R * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx, ry - R);
    ctx.lineTo(rx, ry + R);
    ctx.moveTo(rx - R, ry);
    ctx.lineTo(rx + R, ry);
    ctx.stroke();

    const range = world.shipStats.sensorRange;
    const fwd = qForward(ship.orient);
    const right = { x: 0, y: 0, z: 0 };
    // build ship-local basis: right = fwd × worldUp (stable enough for a radar)
    const up = { x: 0, y: 1, z: 0 };
    right.x = fwd.y * up.z - fwd.z * up.y;
    right.y = fwd.z * up.x - fwd.x * up.z;
    right.z = fwd.x * up.y - fwd.y * up.x;
    const rl = Math.hypot(right.x, right.y, right.z) || 1;
    right.x /= rl; right.y /= rl; right.z /= rl;

    for (const e of world.entities.values()) {
      if (e.id === world.playerId || e.dead) continue;
      const rel = vsub(e.pos, ship.pos);
      const d = vlen(rel);
      if (d > range) continue;
      const fr = vdot(rel, fwd) / d;   // forward component
      const ri = vdot(rel, right) / d; // right component
      const rr = Math.sqrt(d / range) * R; // sqrt scale: nearby contacts spread out
      const px = rx + ri * rr;
      const py = ry - fr * rr;
      const resolved = d < world.shipStats.resolveRange;
      let color = GRAY;
      if (e.kind === 'ship') color = !resolved ? GRAY : e.pirate ? RED : e.isPlayer ? GREEN : CYAN;
      else if (e.kind === 'asteroid') color = 'rgba(140,140,150,0.5)';
      else if (e.kind === 'loot') color = '#d8c46a';
      else if (e.kind === 'fragment') color = '#9ab3a0';
      else if (e.kind === 'missile') color = RED;
      ctx.fillStyle = color;
      const sz = e.kind === 'ship' ? 3 : 2;
      ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
    }
    // station blips (always shown — they're on every chart)
    for (const st of world.system.stations) {
      const rel = vsub(st.pos, ship.pos);
      const d = vlen(rel);
      if (d > range) continue;
      const fr = vdot(rel, fwd) / d;
      const ri = vdot(rel, right) / d;
      const rr = Math.sqrt(d / range) * R;
      ctx.strokeStyle = CYAN;
      ctx.strokeRect(rx + ri * rr - 3, ry - fr * rr - 3, 6, 6);
    }
    ctx.restore();
    ctx.fillStyle = AMBER_DIM;
    ctx.textAlign = 'center';
    ctx.font = '10px "Lucida Console", monospace';
    ctx.fillText(`SCAN ${fmtDistance(range)}`, rx, ry + R + 12);
  }

  private drawLog(now: number, W: number, H: number): void {
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    ctx.font = '12px "Lucida Console", monospace';
    let y = H - 30;
    for (let i = this.log.length - 1; i >= 0; i--) {
      const line = this.log[i];
      const age = (now - line.at) / 1000;
      if (age > 12) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, 1.4 - age / 9));
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, 18, y);
      y -= 17;
    }
    ctx.globalAlpha = 1;
  }

  private vbar(x: number, y: number, w: number, h: number, frac: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = color;
    const fh = Math.max(0, Math.min(1, frac)) * (h - 2);
    ctx.fillRect(x + 1, y + h - 1 - fh, w - 2, fh);
  }

  private hbar(x: number, y: number, w: number, h: number, frac: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, y + 1, Math.max(0, Math.min(1, frac)) * (w - 2), h - 2);
  }
}
