// Flight HUD: a single full-screen canvas drawn every frame. Amber-on-black
// instrument look, deliberately analog and a little dirty.

import * as THREE from 'three';
import { isMobile } from '../game/touch';
import { BOLT_SPEED, GOODS } from '../sim/data';
import type { Entity } from '../sim/types';
import { leadPoint, qForward, qRight, qUp, vdist, vlen, vsub, vnorm, vdot } from '../sim/vec';
import type { IWorld } from '../world_api';
import { fmtDistance, fmtTime } from './dom';

const AMBER = '#d9a441';
const AMBER_DIM = 'rgba(217, 164, 65, 0.45)';
const RED = '#e8402a';
const CYAN = '#7fb1c9';
const GRAY = '#8a8d90';
const GREEN = '#7fc97f';
const PATROL_BLUE = '#6db1ff';
const MERCHANT_GOLD = '#d8c46a';
const CIV_TEAL = '#9fc9c9';

function shipColor(e: { pirate: unknown; isPlayer: boolean; derelict: boolean; npc: string | null }, resolved: boolean): string {
  if (e.derelict) return '#7a8a82';
  if (!resolved && !e.isPlayer) return GRAY;
  if (e.pirate) return RED;
  if (e.isPlayer) return GREEN;
  if (e.npc === 'patrol') return PATROL_BLUE;
  if (e.npc === 'merchant') return MERCHANT_GOLD;
  if (e.npc) return CIV_TEAL;
  return CYAN;
}

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
  showFps = false;

  private proj = new THREE.Vector3();
  private floaters: Array<{ pos: { x: number; y: number; z: number }; text: string; color: string; at: number }> = [];
  private dmgDirs: Array<{ dir: { x: number; y: number; z: number }; at: number }> = [];
  private invQuat = new THREE.Quaternion();
  private dirV = new THREE.Vector3();
  private tmpLocal = new THREE.Vector3(); // scratch for world->screen projections
  private lastFrameAt = 0;
  private fpsTimeAcc = 0;
  private fpsFrames = 0;
  private fpsText = '';
  private mobile = isMobile();

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

  // incoming-fire warning: world direction from the player toward the attacker
  addDamageDir(fromPos: { x: number; y: number; z: number }, shipPos: { x: number; y: number; z: number }): void {
    const dir = vnorm(vsub(fromPos, shipPos));
    this.dmgDirs.push({ dir, at: performance.now() });
    if (this.dmgDirs.length > 6) this.dmgDirs.shift();
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

    // ---- fps readout (moving average, refreshed ~2×/s) ----
    if (this.lastFrameAt > 0 && this.showFps) {
      this.fpsTimeAcc += now - this.lastFrameAt;
      this.fpsFrames++;
      if (this.fpsTimeAcc >= 500) {
        const avg = this.fpsTimeAcc / this.fpsFrames;
        this.fpsText = `${Math.round(1000 / avg)} FPS · ${avg.toFixed(1)} ms`;
        this.fpsTimeAcc = 0;
        this.fpsFrames = 0;
      }
      ctx.textAlign = 'right';
      ctx.font = '11px "Lucida Console", monospace';
      ctx.fillStyle = AMBER_DIM;
      ctx.fillText(this.fpsText, W - 16, 36); // tucked under the credits chip
      ctx.font = '12px "Lucida Console", monospace';
    }
    this.lastFrameAt = now;

    // camera-space transform reused by every screen-edge arrow this frame
    this.invQuat.copy(this.camera.quaternion).invert();

    if (ship.dockedAt) {
      this.drawLog(now, W, H);
      return; // station UI takes over
    }

    const cx = W / 2, cy = H / 2;
    const stats = world.shipStats;

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

    // ---- compass tape (top) ----
    this.drawCompass(world, ship, cx, W);

    // ---- bottom instrument cluster (ED style) ----
    this.drawBottomCluster(world, ship, W, H);

    // ---- world-anchored target bracket + lead pip ----
    const target = ship.targetId !== null ? world.entities.get(ship.targetId) : null;
    if (target && !target.dead) {
      const d = vdist(ship.pos, target.pos);
      const s = this.toScreen(this.tmpLocal.set(target.pos.x - origin.x, target.pos.y - origin.y, target.pos.z - origin.z));
      if (!s.behind) {
        ctx.strokeStyle = target.kind === 'ship' ? shipColor(target, true) : CYAN;
        ctx.lineWidth = 1.2;
        const r = 14;
        ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
      }
      // lead pip: where to aim so your bolts intercept the target. Large and
      // glanceable, and it snaps to a green firing solution when your nose is
      // lined up on it within weapon range (#12).
      if (target.kind === 'ship' && stats.weaponDamage > 0 && d < stats.weaponRange * 1.4) {
        const aim = leadPoint(ship.pos, ship.vel, target.pos, target.vel, BOLT_SPEED);
        const ap = this.toScreen(this.tmpLocal.set(aim.x - origin.x, aim.y - origin.y, aim.z - origin.z));
        if (!ap.behind) {
          const inRange = d < stats.weaponRange;
          const onTarget = inRange && Math.hypot(ap.x - cx, ap.y - cy) < 16;
          const base = onTarget ? GREEN : target.pirate ? RED : CYAN;
          const pulse = 0.55 + 0.45 * Math.sin(now / 80);
          ctx.save();
          ctx.strokeStyle = base;
          ctx.fillStyle = base;
          ctx.globalAlpha = inRange ? 1 : 0.5;
          ctx.lineWidth = onTarget ? 2 : 1.4;
          const r = onTarget ? 9 : 7;
          ctx.beginPath();
          ctx.arc(ap.x, ap.y, r, 0, Math.PI * 2);
          ctx.stroke();
          // crosshair ticks around the pip
          ctx.beginPath();
          ctx.moveTo(ap.x - r - 4, ap.y); ctx.lineTo(ap.x - r, ap.y);
          ctx.moveTo(ap.x + r, ap.y); ctx.lineTo(ap.x + r + 4, ap.y);
          ctx.moveTo(ap.x, ap.y - r - 4); ctx.lineTo(ap.x, ap.y - r);
          ctx.moveTo(ap.x, ap.y + r); ctx.lineTo(ap.x, ap.y + r + 4);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(ap.x, ap.y, 1.8, 0, Math.PI * 2);
          ctx.fill();
          if (onTarget) {
            // pulsing corner brackets: you have a firing solution, shoot now
            ctx.globalAlpha = pulse;
            ctx.lineWidth = 2;
            const b = 13;
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
              ctx.beginPath();
              ctx.moveTo(ap.x + sx * b, ap.y + sy * b - sy * 5);
              ctx.lineTo(ap.x + sx * b, ap.y + sy * b);
              ctx.lineTo(ap.x + sx * b - sx * 5, ap.y + sy * b);
              ctx.stroke();
            }
          }
          ctx.restore();
        }
      }
    }

    // ---- incoming-fire direction arrows ----
    for (let i = this.dmgDirs.length - 1; i >= 0; i--) {
      const dd = this.dmgDirs[i];
      const age = (now - dd.at) / 1000;
      if (age > 1.6) {
        this.dmgDirs.splice(i, 1);
        continue;
      }
      // world direction -> camera space -> ring angle (same math as the GPS arrow)
      this.dirV.set(dd.dir.x, dd.dir.y, dd.dir.z).applyQuaternion(this.invQuat);
      const ang = Math.atan2(this.dirV.x, this.dirV.y);
      const ringR = 92;
      const ax = cx + Math.sin(ang) * ringR;
      const ay = cy - Math.cos(ang) * ringR;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.globalAlpha = Math.max(0, 1 - age / 1.6);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); // double chevron pointing at the attacker
      ctx.moveTo(-8, 2);
      ctx.lineTo(0, -7);
      ctx.lineTo(8, 2);
      ctx.moveTo(-8, 8);
      ctx.lineTo(0, -1);
      ctx.lineTo(8, 8);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
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
      const s = this.toScreen(this.tmpLocal.set(f.pos.x - origin.x, f.pos.y - origin.y, f.pos.z - origin.z));
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

  // Scrolling heading tape with destination/target markers: tells you which
  // way to turn without hunting for the off-screen arrow.
  private drawCompass(world: IWorld, ship: Entity, cx: number, W: number): void {
    const ctx = this.ctx;
    const y = 26;
    const barW = Math.min(440, W * 0.42);
    const SPAN = 120; // degrees visible
    const pxPerDeg = barW / SPAN;
    const fwd = qForward(ship.orient);
    const heading = (Math.atan2(fwd.x, -fwd.z) * 180 / Math.PI + 360) % 360;

    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - barW / 2, y);
    ctx.lineTo(cx + barW / 2, y);
    ctx.stroke();
    // graduations every 15°, labels every 45°
    ctx.font = '9px "Lucida Console", monospace';
    ctx.textAlign = 'center';
    for (let deg = 0; deg < 360; deg += 15) {
      let rel = deg - heading;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      if (Math.abs(rel) > SPAN / 2) continue;
      const x = cx + rel * pxPerDeg;
      const major = deg % 45 === 0;
      ctx.strokeStyle = AMBER_DIM;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - (major ? 7 : 4));
      ctx.stroke();
      if (major) {
        ctx.fillStyle = AMBER_DIM;
        ctx.fillText(String(deg).padStart(3, '0'), x, y + 9);
      }
    }
    // nose notch
    ctx.strokeStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(cx, y + 2);
    ctx.lineTo(cx - 4, y + 8);
    ctx.moveTo(cx, y + 2);
    ctx.lineTo(cx + 4, y + 8);
    ctx.stroke();

    // marker helper: world pos -> bearing offset + elevation arrow
    const marker = (pos: { x: number; y: number; z: number }, color: string, diamond: boolean) => {
      const local = this.tmpLocal.set(pos.x - ship.pos.x, pos.y - ship.pos.y, pos.z - ship.pos.z)
        .applyQuaternion(this.invQuat);
      const bearing = Math.atan2(local.x, -local.z) * 180 / Math.PI;
      const clamped = Math.max(-SPAN / 2, Math.min(SPAN / 2, bearing));
      const x = cx + clamped * pxPerDeg;
      ctx.fillStyle = color;
      if (Math.abs(bearing) > SPAN / 2) {
        // off-tape: edge arrow
        const dirSign = Math.sign(bearing);
        ctx.beginPath();
        ctx.moveTo(x + dirSign * 6, y - 5);
        ctx.lineTo(x, y - 9);
        ctx.lineTo(x, y - 1);
        ctx.closePath();
        ctx.fill();
      } else if (diamond) {
        ctx.beginPath();
        ctx.moveTo(x, y - 11);
        ctx.lineTo(x + 5, y - 6);
        ctx.lineTo(x, y - 1);
        ctx.lineTo(x - 5, y - 6);
        ctx.closePath();
        ctx.fill();
        // pitch hint: chevron above/below when the marker needs vertical correction
        const elev = Math.atan2(local.y, Math.hypot(local.x, local.z)) * 180 / Math.PI;
        if (Math.abs(elev) > 8) {
          ctx.fillText(elev > 0 ? '▲' : '▼', x, elev > 0 ? y - 18 : y + 18);
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(x, y - 10);
        ctx.lineTo(x + 4, y - 2);
        ctx.lineTo(x - 4, y - 2);
        ctx.closePath();
        ctx.fill();
      }
    };
    if (world.destination) marker(world.destination.pos, AMBER, true);
    const target = ship.targetId !== null ? world.entities.get(ship.targetId) : null;
    if (target && !target.dead && target.kind === 'ship') marker(target.pos, target.pirate ? RED : CYAN, false);
  }

  private drawDestination(world: IWorld, ship: Entity, origin: { x: number; y: number; z: number }, cx: number, cy: number, W: number, H: number): void {
    const ctx = this.ctx;
    const dest = world.destination;
    this.destAligned = false;
    if (!dest) return;
    const navQ = world.shipStats.navQuality;
    const d = vdist(ship.pos, dest.pos);
    const s = this.toScreen(this.tmpLocal.set(dest.pos.x - origin.x, dest.pos.y - origin.y, dest.pos.z - origin.z));
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
      const dir2 = this.tmpLocal.set(dest.pos.x - origin.x, dest.pos.y - origin.y, dest.pos.z - origin.z)
        .applyQuaternion(this.invQuat);
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
      const s = this.toScreen(this.tmpLocal.set(e.pos.x - origin.x, e.pos.y - origin.y, e.pos.z - origin.z));
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
          ctx.strokeStyle = shipColor(e, true);
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

  // ---------------------------------------------------------------------
  // ED-style bottom instrument cluster: holo target panel | gauges |
  // elliptical 3D scanner | shield arcs | holo status panel
  // ---------------------------------------------------------------------

  private holoPanel(x: number, y: number, w: number, h: number, title: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(30, 22, 8, 0.55)';
    ctx.strokeStyle = 'rgba(217, 164, 65, 0.5)';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    // title tab
    ctx.fillStyle = 'rgba(217, 164, 65, 0.16)';
    ctx.fillRect(x, y, w, 16);
    ctx.fillStyle = AMBER;
    ctx.font = '10px "Lucida Console", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(title, x + 8, y + 8);
    // corner notches
    ctx.strokeStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(x, y + 8); ctx.lineTo(x, y); ctx.lineTo(x + 8, y);
    ctx.moveTo(x + w - 8, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - 8);
    ctx.stroke();
  }

  private drawBottomCluster(world: IWorld, ship: Entity, W: number, H: number): void {
    const ctx = this.ctx;
    const cx = W / 2;
    const stats = world.shipStats;
    const rx = Math.max(95, Math.min(130, W * 0.085));
    const ry = rx * 0.42;
    const scY = H - Math.max(78, ry + 36);

    this.drawScanner(world, ship, cx, scY, rx, ry);

    // ---- gauges (left of scanner): speed readout + THR/FUE/TRB ----
    const gx = cx - rx - 92;
    const gy = scY + 8;
    const speed = vlen(ship.vel);
    ctx.textAlign = 'right';
    ctx.fillStyle = world.turboActive ? '#ff8830' : AMBER;
    ctx.font = '19px "Lucida Console", monospace';
    ctx.fillText(speed > 10_000 ? `${(speed / 1000).toFixed(1)} km/s` : `${Math.round(speed)} m/s`, gx + 72, gy - 58);
    ctx.font = '10px "Lucida Console", monospace';
    ctx.fillStyle = world.turboActive ? '#ff8830' : AMBER_DIM;
    ctx.fillText(
      world.turboActive ? 'TURBO OVERBURN'
        : ship.cruise === 'cruise' ? 'CRUISE'
          : ship.cruise === 'charging' ? 'CRUISE CHARGE…'
            : `THR ${Math.round(ship.throttle * 100)}%`,
      gx + 72, gy - 42);
    ctx.textAlign = 'center';
    const fuelFrac = world.profile.fuel / stats.fuelMax;
    this.vbar(gx, gy - 30, 7, 56, Math.abs(ship.throttle), ship.throttle < 0 ? RED : AMBER);
    this.vbar(gx + 26, gy - 30, 7, 56, fuelFrac, fuelFrac < 0.2 ? RED : CYAN);
    this.vbar(gx + 52, gy - 30, 7, 56, world.turboCharge, world.turboActive ? '#ff8830' : 'rgba(255, 136, 48, 0.55)');
    if (stats.drillRate > 0) {
      const heatColor = world.drillOverheated ? RED : world.drillHeat > 0.7 ? '#ff8830' : AMBER;
      this.vbar(gx - 26, gy - 30, 7, 56, world.drillHeat, heatColor);
    }
    ctx.fillStyle = AMBER_DIM;
    ctx.font = '9px "Lucida Console", monospace';
    if (stats.drillRate > 0) {
      ctx.fillStyle = world.drillOverheated ? RED : AMBER_DIM;
      ctx.fillText(world.drillOverheated ? 'HOT!' : 'DRL', gx - 23, gy + 36);
      ctx.fillStyle = AMBER_DIM;
    }
    ctx.fillText('THR', gx + 3, gy + 36);
    ctx.fillText('FUE', gx + 29, gy + 36);
    ctx.fillText('TRB', gx + 55, gy + 36);
    if (fuelFrac < 0.2) {
      ctx.fillStyle = RED;
      ctx.fillText(fuelFrac <= 0.02 ? 'FUEL EMPTY' : 'FUEL LOW', gx + 30, gy + 50);
    }
    if (!world.flightAssist) {
      ctx.fillStyle = CYAN;
      ctx.fillText('FA OFF', gx + 30, gy - 74);
    }
    if (world.drillOn) {
      ctx.fillStyle = world.drillOverheated ? RED : '#9ab3a0';
      ctx.fillText(world.drillOverheated ? 'DRILL VENTING' : 'DRILL — hold RMB to mine', gx + 30, gy - 88);
    }

    // ---- shield arcs + hull (right of scanner) ----
    const sx = cx + rx + 92;
    const sy = scY + 4;
    const shieldFrac = ship.maxShield > 0 ? ship.shield / ship.maxShield : 0;
    // ship silhouette
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 9);
    ctx.lineTo(sx + 7, sy + 7);
    ctx.lineTo(sx, sy + 3);
    ctx.lineTo(sx - 7, sy + 7);
    ctx.closePath();
    ctx.stroke();
    // three concentric shield arcs, lit by charge level (front + rear)
    for (let i = 0; i < 3; i++) {
      const lit = shieldFrac > (i + 0.34) / 3;
      ctx.strokeStyle = lit ? CYAN : 'rgba(127, 177, 201, 0.18)';
      ctx.lineWidth = 2;
      const r = 15 + i * 5.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r, -Math.PI * 0.82, -Math.PI * 0.18);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, r, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();
    }
    // hull bar + readouts
    const hullFrac = ship.hull / ship.maxHull;
    this.hbar(sx - 34, sy + 36, 68, 6, hullFrac, hullFrac < 0.25 ? RED : AMBER);
    ctx.textAlign = 'center';
    ctx.font = '9px "Lucida Console", monospace';
    ctx.fillStyle = AMBER_DIM;
    ctx.fillText(`HUL ${Math.round(ship.hull)}`, sx, sy + 50);
    ctx.fillText(`SHD ${Math.round(ship.shield)}`, sx, sy - 38);
    const ammoBits: string[] = [];
    if (stats.cannonAmmoMax > 0) ammoBits.push(`AMM ${ship.cannonAmmo}`);
    if (stats.missileAmmoMax > 0) ammoBits.push(`MSL ${ship.missileAmmo}`);
    if (ammoBits.length > 0) {
      ctx.fillStyle = stats.cannonAmmoMax > 0 && ship.cannonAmmo <= 0 ? RED : AMBER_DIM;
      ctx.fillText(ammoBits.join(' '), sx, sy + 62);
    }

    // ---- corner holo panels ----
    const pw = Math.min(252, Math.max(200, W * 0.19));
    const ph = 128;
    if (this.mobile) {
      // phones: chromeless HUD text lifted above the corner ROLL buttons,
      // with a soft dark glow so it stays readable over bright backdrops
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 5;
      this.drawTargetPanel(world, ship, 8, H - ph - 88, pw, ph);
      this.drawStatusPanel(world, ship, W - pw - 8, H - ph - 88, pw, ph);
      ctx.restore();
    } else {
      this.drawTargetPanel(world, ship, 14, H - ph - 12, pw, ph);
      this.drawStatusPanel(world, ship, W - pw - 14, H - ph - 12, pw, ph);
    }
  }

  // ED-style scanner: perspective ellipse, contacts as stalked blips showing
  // height above/below your ship's plane. Rolls with the ship.
  private drawScanner(world: IWorld, ship: Entity, cx: number, cy: number, rx: number, ry: number): void {
    const ctx = this.ctx;
    ctx.save();
    // disc
    ctx.fillStyle = 'rgba(20, 14, 5, 0.6)';
    ctx.strokeStyle = 'rgba(217, 164, 65, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (const f of [0.66, 0.33]) {
      ctx.strokeStyle = 'rgba(217, 164, 65, 0.22)';
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * f, ry * f, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(217, 164, 65, 0.22)';
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy);
    ctx.lineTo(cx + rx, cy);
    ctx.moveTo(cx, cy - ry);
    ctx.lineTo(cx, cy + ry);
    ctx.stroke();
    // sweep
    const sweep = (performance.now() / 1400) % (Math.PI * 2);
    ctx.strokeStyle = 'rgba(217, 164, 65, 0.30)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweep) * rx, cy + Math.sin(sweep) * ry);
    ctx.stroke();
    // own ship notch
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx + 3, cy + 3);
    ctx.lineTo(cx - 3, cy + 3);
    ctx.closePath();
    ctx.fill();

    const range = world.shipStats.sensorRange;
    const fwd = qForward(ship.orient);
    const rightAxis = qRight(ship.orient);
    const upAxis = qUp(ship.orient);

    const blip = (pos: { x: number; y: number; z: number }, color: string, isStation: boolean, isTarget: boolean) => {
      // scalar math: this runs for every entity every frame — no vec allocs
      const relX = pos.x - ship.pos.x, relY = pos.y - ship.pos.y, relZ = pos.z - ship.pos.z;
      const d = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
      if (d > range || d < 1) return;
      const nd = Math.sqrt(d / range); // sqrt scale spreads nearby contacts
      const fr = (relX * fwd.x + relY * fwd.y + relZ * fwd.z) / d;
      const ri = (relX * rightAxis.x + relY * rightAxis.y + relZ * rightAxis.z) / d;
      const up = (relX * upAxis.x + relY * upAxis.y + relZ * upAxis.z) / d;
      const px = cx + ri * nd * rx;
      const py = cy - fr * nd * ry;
      const stalk = -up * nd * (ry * 0.9); // canvas y grows downward
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      if (Math.abs(stalk) > 2) {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + stalk);
        ctx.stroke();
      }
      if (isStation) {
        ctx.strokeRect(px - 3, py + stalk - 3, 6, 6);
      } else {
        ctx.fillRect(px - 2, py + stalk - 2, 4, 4);
      }
      if (isTarget) {
        ctx.beginPath();
        ctx.arc(px, py + stalk, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    for (const e of world.entities.values()) {
      if (e.id === world.playerId || e.dead) continue;
      const resolved = vdist(e.pos, ship.pos) < world.shipStats.resolveRange;
      let color = GRAY;
      if (e.kind === 'ship') color = shipColor(e, resolved);
      else if (e.kind === 'asteroid') color = 'rgba(140,140,150,0.45)';
      else if (e.kind === 'loot') color = '#d8c46a';
      else if (e.kind === 'fragment') color = '#9ab3a0';
      else if (e.kind === 'missile') color = RED;
      else if (e.kind === 'bolt') continue;
      blip(e.pos, color, false, e.id === ship.targetId);
    }
    for (const st of world.system.stations) {
      blip(st.pos, CYAN, true, false);
    }
    ctx.restore();
    ctx.fillStyle = AMBER_DIM;
    ctx.textAlign = 'center';
    ctx.font = '9px "Lucida Console", monospace';
    ctx.fillText(`SCAN ${fmtDistance(world.shipStats.sensorRange)}`, cx, cy + ry + 11);
  }

  // window chrome on desktop; on phones just a dim spaced caption — the
  // panels render as transparent HUD text straight over the game view
  private panelFrame(x: number, y: number, w: number, h: number, title: string, right = false): void {
    if (!this.mobile) {
      this.holoPanel(x, y, w, h, title);
      return;
    }
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(217, 164, 65, 0.5)';
    ctx.font = '9px "Lucida Console", monospace';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(title.split('').join(' '), right ? x + w - 10 : x + 10, y + 10);
  }

  private drawTargetPanel(world: IWorld, ship: Entity, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    this.panelFrame(x, y, w, h, 'TARGET');
    const target = ship.targetId !== null ? world.entities.get(ship.targetId) : null;
    ctx.textAlign = 'left';
    if (!target || target.dead) {
      ctx.fillStyle = GRAY;
      ctx.font = '11px "Lucida Console", monospace';
      ctx.fillText('no target — [T] reticle · [Tab] hostiles', x + 10, y + 40);
      return;
    }
    const d = vdist(ship.pos, target.pos);
    const resolved = d < world.shipStats.resolveRange;
    ctx.font = '12px "Lucida Console", monospace';
    ctx.fillStyle = target.kind !== 'ship' ? GRAY : shipColor(target, resolved);
    const name = target.kind === 'ship' && !resolved && !target.isPlayer ? 'UNRESOLVED SIGNATURE' : target.name.toUpperCase();
    ctx.fillText(name.slice(0, 26), x + 10, y + 30);
    ctx.font = '11px "Lucida Console", monospace';
    ctx.fillStyle = AMBER_DIM;
    ctx.fillText(fmtDistance(d), x + 10, y + 46);
    if (target.kind === 'ship' && !target.derelict) {
      ctx.fillText('SHD', x + 10, y + 64);
      this.hbar(x + 42, y + 60, w - 56, 6, target.shield / Math.max(1, target.maxShield), CYAN);
      ctx.fillText('HUL', x + 10, y + 80);
      this.hbar(x + 42, y + 76, w - 56, 6, target.hull / target.maxHull, AMBER);
      const stats = world.shipStats;
      if (stats.missileAmmoMax > 0 && ship.missileAmmo > 0) {
        const lockFrac = ship.lockedOn ? 1 : ship.lockTimer / stats.missileLockTime;
        ctx.fillStyle = ship.lockedOn ? RED : AMBER_DIM;
        ctx.fillText(ship.lockedOn ? 'MISSILE LOCK ◆' : lockFrac > 0 ? `LOCK ${Math.round(lockFrac * 100)}%` : '', x + 10, y + 100);
      }
    } else if (target.kind === 'asteroid' && target.rockYield) {
      this.hbar(x + 10, y + 60, w - 24, 6, target.rockHp / Math.max(1, target.rockMaxHp), GRAY);
      if (world.shipStats.compositionScan) {
        let line = y + 80;
        for (const [g, q] of Object.entries(target.rockYield)) {
          if (q <= 0 || line > y + h - 10) continue;
          ctx.fillStyle = AMBER_DIM;
          ctx.fillText(`${GOODS[g]?.name ?? g}: ~${Math.round(q)}`, x + 10, line);
          line += 14;
        }
      } else {
        ctx.fillStyle = GRAY;
        ctx.fillText('composition: Mk III sensor needed', x + 10, y + 82);
      }
    } else if (target.derelict) {
      ctx.fillStyle = '#7a8a82';
      ctx.fillText('cold hull — approach to board', x + 10, y + 66);
    }
  }

  private drawStatusPanel(world: IWorld, ship: Entity, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    this.panelFrame(x, y, w, h, 'SHIP STATUS', this.mobile);
    ctx.textAlign = 'left';
    ctx.font = '11px "Lucida Console", monospace';
    const prof = world.profile;
    const stats = world.shipStats;
    let used = 0;
    for (const c of prof.cargo) used += (GOODS[c.good]?.volume ?? 1) * c.qty;
    const lines: Array<[string, string, string]> = [
      ['CR', `${Math.round(prof.credits).toLocaleString('en-US')}`, AMBER],
      ['CARGO', `${used.toFixed(0)}/${stats.cargoCapacity} m³`, AMBER_DIM],
      ['FUEL', `${prof.fuel.toFixed(0)}/${stats.fuelMax}`, prof.fuel / stats.fuelMax < 0.2 ? RED : AMBER_DIM],
    ];
    if (world.destination) {
      const d = vdist(ship.pos, world.destination.pos);
      lines.push(['DEST', `${world.destination.name.slice(0, 16)} ${fmtDistance(d)}`, AMBER_DIM]);
      const closing = vdot(ship.vel, vnorm(vsub(world.destination.pos, ship.pos)));
      if (stats.navQuality > 0 && closing > 5) lines.push(['ETA', fmtTime(d / closing), AMBER_DIM]);
    } else {
      lines.push(['DEST', '— set on chart [M]', GRAY]);
    }
    let ly = y + 32;
    if (this.mobile) {
      // chromeless block hugs the right screen edge: values right-aligned,
      // dim labels leading them
      ctx.textAlign = 'right';
      for (const [k, v, color] of lines) {
        ctx.fillStyle = color;
        ctx.fillText(v, x + w - 10, ly);
        ctx.fillStyle = AMBER_DIM;
        ctx.fillText(k, x + w - 16 - ctx.measureText(v).width, ly);
        ly += 17;
      }
      ctx.textAlign = 'left';
      return;
    }
    for (const [k, v, color] of lines) {
      ctx.fillStyle = AMBER_DIM;
      ctx.fillText(k, x + 10, ly);
      ctx.fillStyle = color;
      ctx.fillText(v, x + 60, ly);
      ly += 17;
    }
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
