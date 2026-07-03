// Flight HUD: a single full-screen canvas drawn every frame. Amber-on-black
// instrument look, deliberately analog and a little dirty.

import * as THREE from 'three';
import { isMobile } from '../game/touch';
import { BOLT_SPEED, GOODS } from '../sim/data';
import { approachTarget } from '../sim/docking';
import { surfaceEnvAt } from '../sim/surface';
import type { Entity } from '../sim/types';
import { leadPoint, qForward, qRight, qUp, vdist, vlen, vscale, vsub, vnorm, vdot } from '../sim/vec';
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
  entryHeat = 0;       // 0..1 atmospheric-entry glow, set by the app (#16)
  // approach radar state (#18), read back by the app for the proximity beep
  approachQuality: 'red' | 'amber' | 'green' | null = null;
  approachDist = Infinity;

  private proj = new THREE.Vector3();
  private floaters: Array<{ pos: { x: number; y: number; z: number }; text: string; color: string; at: number }> = [];
  private dmgDirs: Array<{ dir: { x: number; y: number; z: number }; at: number }> = [];
  private invQuat = new THREE.Quaternion();
  private dirV = new THREE.Vector3();
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
      const tl = new THREE.Vector3(target.pos.x - origin.x, target.pos.y - origin.y, target.pos.z - origin.z);
      const s = this.toScreen(tl);
      if (!s.behind) {
        ctx.strokeStyle = target.pirate ? RED : CYAN;
        ctx.lineWidth = 1.2;
        const r = 14;
        ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
      }
      // lead pip: where to aim so your bolts intercept the target (#12).
      // Big, animated, and it SNAPS when your nose is on the solution.
      if (target.kind === 'ship' && stats.weaponDamage > 0 && d < stats.weaponRange * 1.6) {
        const aim = leadPoint(ship.pos, ship.vel, target.pos, target.vel, BOLT_SPEED);
        const al = new THREE.Vector3(aim.x - origin.x, aim.y - origin.y, aim.z - origin.z);
        const ap = this.toScreen(al);
        if (!ap.behind) {
          const aimDir = vnorm(vsub(aim, ship.pos));
          const offAngle = Math.acos(Math.max(-1, Math.min(1, vdot(qForward(ship.orient), aimDir))));
          const onTarget = offAngle < 0.022; // ~1.3° — bolts will connect
          const inRange = d < stats.weaponRange;
          const col = onTarget ? '#ffe08a' : target.pirate ? RED : CYAN;
          ctx.globalAlpha = inRange ? 1 : 0.45;
          ctx.strokeStyle = col;
          ctx.fillStyle = col;
          ctx.lineWidth = onTarget ? 2.2 : 1.6;
          const r = onTarget ? 11 : 9;
          ctx.beginPath();
          ctx.arc(ap.x, ap.y, r, 0, Math.PI * 2);
          ctx.stroke();
          // crosshair ticks
          ctx.beginPath();
          ctx.moveTo(ap.x - r - 5, ap.y); ctx.lineTo(ap.x - r + 2, ap.y);
          ctx.moveTo(ap.x + r - 2, ap.y); ctx.lineTo(ap.x + r + 5, ap.y);
          ctx.moveTo(ap.x, ap.y - r - 5); ctx.lineTo(ap.x, ap.y - r + 2);
          ctx.moveTo(ap.x, ap.y + r - 2); ctx.lineTo(ap.x, ap.y + r + 5);
          ctx.stroke();
          if (onTarget) {
            // solid center + pulse ring: FIRE NOW
            ctx.beginPath();
            ctx.arc(ap.x, ap.y, 3, 0, Math.PI * 2);
            ctx.fill();
            const pulse = (performance.now() % 500) / 500;
            ctx.globalAlpha = (1 - pulse) * (inRange ? 0.8 : 0.3);
            ctx.beginPath();
            ctx.arc(ap.x, ap.y, r + pulse * 10, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillRect(ap.x - 1, ap.y - 1, 2, 2);
          }
          ctx.globalAlpha = 1;
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
      this.invQuat.copy(this.camera.quaternion).invert();
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

    // ---- approach radar instrument (#18) ----
    this.drawApproachRadar(world, ship, W);

    // ---- surface flight cues (#16/#19) ----
    const env = surfaceEnvAt(world.surfaceBodies, ship.pos);
    if (env && env.altitude < 25_000) {
      ctx.textAlign = 'center';
      ctx.font = '13px "Lucida Console", monospace';
      const vs = vdot(ship.vel, env.up);
      ctx.fillStyle = env.altitude < 400 && vs < -12 ? RED : AMBER;
      ctx.fillText(`ALT ${env.altitude > 9999 ? `${(env.altitude / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(env.altitude))} m`}  VS ${vs > 0 ? '+' : ''}${Math.round(vs)}`, cx, H * 0.24);
    }
    if (world.landedOn) {
      ctx.textAlign = 'center';
      ctx.fillStyle = GREEN;
      ctx.font = '14px "Lucida Console", monospace';
      ctx.fillText('◆ LANDED — throttle up to lift off ◆', cx, H * 0.30);
    }

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

    // ---- approach prompt (#20): Space asks the tower, flying does the rest ----
    ctx.textAlign = 'center';
    if (!world.approach) {
      const nearStation = world.system.stations.find((s) => vdist(s.pos, ship.pos) < s.dockRadius * 2.5);
      const nearPort = nearStation ? undefined : world.surfaceBodies.find((b) =>
        b.pads.length > 0 && vdist(b.pos, ship.pos) < b.radius * 1.6);
      if (nearStation || nearPort) {
        ctx.fillStyle = AMBER;
        ctx.font = '13px "Lucida Console", monospace';
        ctx.fillText(`[SPACE] REQUEST APPROACH — ${(nearStation?.name ?? nearPort?.name ?? '').toUpperCase()}`, cx, H * 0.2);
      }
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

    // ---- atmospheric entry heat (#16): the edges of the canopy cook ----
    if (this.entryHeat > 0.04) {
      const a = Math.min(0.55, this.entryHeat * 0.5) * (0.75 + Math.random() * 0.25);
      const grad = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.30, cx, cy, Math.max(W, H) * 0.62);
      grad.addColorStop(0, 'rgba(255,120,40,0)');
      grad.addColorStop(1, `rgba(255,105,25,${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
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
      const local = new THREE.Vector3(pos.x - ship.pos.x, pos.y - ship.pos.y, pos.z - ship.pos.z)
        .applyQuaternion(this.camera.quaternion.clone().invert());
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

  // Approach radar (#18): a compact red/amber/green instrument that wakes on
  // final approach and dims away otherwise. Shows a deviation scope (where
  // the corridor is relative to your nose), distance and closure rate.
  private drawApproachRadar(world: IWorld, ship: Entity, W: number): void {
    this.approachQuality = null;
    this.approachDist = Infinity;
    const appr = world.approach;
    if (!appr) return;
    const target = approachTarget(world.system, world.surfaceBodies, appr);
    if (!target) return;
    const d = vdist(ship.pos, target.pos);
    if (d > 6500) return; // not in the approach phase yet
    const ctx = this.ctx;

    const toT = vnorm(vsub(target.pos, ship.pos));
    const closure = vdot(ship.vel, toT);
    // lateral deviation from the approach axis through the target
    const rel = vsub(ship.pos, target.pos);
    const outDir = vscale(target.inDir, -1);
    const axial = vdot(rel, outDir);
    const latVec = vsub(rel, vscale(outDir, axial));
    const lat = vlen(latVec);
    const corridor = appr.slot === 'clamp' ? 28 : appr.slot === 'bay' ? 55 : 40;
    const latNorm = lat / Math.max(1, corridor + d * 0.22); // funnel widens out
    const vLimit = (appr.slot === 'clamp' ? 8 : appr.slot === 'bay' ? 20 : 10) + d / 12;
    const wrongSide = axial < 0 && d < 900; // slipped behind the target plane
    let quality: 'red' | 'amber' | 'green' = 'green';
    if (latNorm > 1.6 || closure > vLimit * 1.8 || closure < -6 || wrongSide) quality = 'red';
    else if (latNorm > 0.9 || closure > vLimit) quality = 'amber';
    this.approachQuality = quality;
    this.approachDist = d;

    const pw = 190, ph = 96;
    // phones: the top-right corner belongs to the FIRE button and credits
    // chip — the approach aid moves to top-center, under the compass
    const px = this.mobile ? Math.round((W - pw) / 2) : W - pw - 14;
    const py = this.mobile ? 72 : 40;
    this.holoPanel(px, py, pw, ph, 'APPROACH');
    const col = quality === 'green' ? GREEN : quality === 'amber' ? '#e0b34d' : RED;

    // deviation scope: dot = where the corridor axis is relative to you
    const sx = px + 34, sy = py + 58, sr = 26;
    ctx.strokeStyle = 'rgba(217,164,65,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - sr, sy); ctx.lineTo(sx + sr, sy);
    ctx.moveTo(sx, sy - sr); ctx.lineTo(sx, sy + sr);
    ctx.stroke();
    // project the lateral offset onto camera right/up: fly TOWARD the dot
    this.invQuat.copy(this.camera.quaternion).invert();
    this.dirV.set(-latVec.x, -latVec.y, -latVec.z).applyQuaternion(this.invQuat);
    const k = Math.min(1, latNorm) * sr * 0.85;
    const norm = Math.hypot(this.dirV.x, this.dirV.y) || 1;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(sx + (this.dirV.x / norm) * k * Math.min(1, latNorm), sy - (this.dirV.y / norm) * k * Math.min(1, latNorm), 4, 0, Math.PI * 2);
    ctx.fill();

    // status column
    ctx.textAlign = 'left';
    ctx.font = '11px "Lucida Console", monospace';
    ctx.fillStyle = col;
    const slotLabel = appr.slot === 'bay' ? 'BAY' : appr.slot === 'clamp' ? 'CLAMP A' : appr.slot.split('_pad_').length > 1 ? `PAD ${appr.slot.split('_pad_')[1]}` : appr.slot;
    ctx.fillText(`● ${slotLabel}`, px + 72, py + 34);
    ctx.fillStyle = AMBER_DIM;
    ctx.fillText(`DST ${fmtDistance(d)}`, px + 72, py + 52);
    ctx.fillStyle = closure > vLimit ? RED : AMBER_DIM;
    ctx.fillText(`CLO ${Math.round(closure)} m/s`, px + 72, py + 68);
    if (appr.slot !== 'bay' && appr.slot !== 'clamp') {
      ctx.fillStyle = world.gearFrac >= 0.99 ? GREEN : RED;
      ctx.fillText(world.gearFrac >= 0.99 ? 'GEAR ▼' : 'GEAR ▲ !', px + 72, py + 84);
    } else if (appr.slot === 'clamp') {
      const aln = vdot(qForward(ship.orient), target.inDir);
      ctx.fillStyle = aln > 0.94 ? GREEN : AMBER_DIM;
      ctx.fillText(`ALN ${Math.max(0, Math.round(aln * 100))}%`, px + 72, py + 84);
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
    const now = performance.now();
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
    ctx.fillStyle = AMBER_DIM;
    ctx.font = '9px "Lucida Console", monospace';
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
    // flight mode + gear state (#18/#19): always visible
    ctx.font = '10px "Lucida Console", monospace';
    ctx.fillStyle = world.vtol ? '#7fd4ff' : AMBER_DIM;
    ctx.fillText(world.vtol ? 'MODE: VTOL ▼' : 'MODE: CRUISE', gx + 30, gy - 88);
    const gearT = world.gearFrac;
    if (gearT >= 0.99) {
      ctx.fillStyle = GREEN;
      ctx.fillText('GEAR ▼ DOWN', gx + 30, gy - 100);
    } else if (gearT > 0.01) {
      if (Math.sin(now / 90) > 0) {
        ctx.fillStyle = AMBER;
        ctx.fillText('GEAR ◇ CYCLING', gx + 30, gy - 100);
      }
    } else {
      ctx.fillStyle = 'rgba(138,141,144,0.6)';
      ctx.fillText('GEAR ▲ UP', gx + 30, gy - 100);
    }

    // ---- ship vitals (right of scanner): big glanceable gauges (#13) ----
    // Combat-critical readouts as thick segmented bars with large numerics,
    // pulsing on low/critical states. Nothing here sits over the center view.
    const vx = cx + rx + 36;
    const vw = Math.max(140, Math.min(210, W - vx - 24));
    let vy = scY - 52;
    const shieldFrac = ship.maxShield > 0 ? ship.shield / ship.maxShield : 0;
    const hullFrac = ship.hull / ship.maxHull;
    const pulse = Math.sin(now / 110) > -0.2; // fast blink for critical states

    // SHIELD: 6 segments, blue; flat grey when down
    const shieldDown = ship.maxShield > 0 && ship.shield <= 0.5;
    ctx.textAlign = 'left';
    ctx.font = '11px "Lucida Console", monospace';
    ctx.fillStyle = shieldDown ? (pulse ? RED : AMBER_DIM) : CYAN;
    ctx.fillText(shieldDown ? 'SHD ✕' : 'SHD', vx, vy);
    ctx.textAlign = 'right';
    ctx.font = '17px "Lucida Console", monospace';
    ctx.fillText(`${Math.round(ship.shield)}`, vx + vw, vy);
    this.segBar(vx, vy + 7, vw, 11, shieldFrac, 6, shieldDown && pulse ? 'rgba(232,64,42,0.5)' : CYAN);
    vy += 34;

    // HULL: solid thick bar, amber -> red under 25% with pulse
    const hullCrit = hullFrac < 0.25;
    ctx.textAlign = 'left';
    ctx.font = '11px "Lucida Console", monospace';
    ctx.fillStyle = hullCrit ? (pulse ? RED : AMBER_DIM) : AMBER;
    ctx.fillText('HUL', vx, vy);
    ctx.textAlign = 'right';
    ctx.font = '17px "Lucida Console", monospace';
    ctx.fillStyle = hullCrit ? RED : AMBER;
    ctx.fillText(`${Math.round(hullFrac * 100)}%`, vx + vw, vy);
    this.hbar(vx, vy + 7, vw, 11, hullFrac, hullCrit ? (pulse ? RED : 'rgba(232,64,42,0.45)') : AMBER);
    vy += 34;

    // AMMO: magazine blocks + big count; missile diamonds
    if (stats.cannonAmmoMax > 0) {
      const ammoFrac = ship.cannonAmmo / stats.cannonAmmoMax;
      const ammoOut = ship.cannonAmmo <= 0;
      const ammoLow = ammoFrac < 0.2;
      ctx.textAlign = 'left';
      ctx.font = '11px "Lucida Console", monospace';
      ctx.fillStyle = ammoOut ? (pulse ? RED : AMBER_DIM) : ammoLow ? RED : AMBER_DIM;
      ctx.fillText(ammoOut ? 'AMM — EMPTY' : 'AMM', vx, vy);
      ctx.textAlign = 'right';
      ctx.font = '17px "Lucida Console", monospace';
      ctx.fillStyle = ammoOut ? RED : ammoLow ? RED : AMBER;
      ctx.fillText(`${ship.cannonAmmo}`, vx + vw, vy);
      this.segBar(vx, vy + 7, vw, 8, ammoFrac, 10, ammoLow ? RED : '#c9974a');
      vy += 30;
    }
    if (stats.missileAmmoMax > 0) {
      ctx.textAlign = 'left';
      ctx.font = '11px "Lucida Console", monospace';
      ctx.fillStyle = AMBER_DIM;
      ctx.fillText('MSL', vx, vy);
      for (let i = 0; i < stats.missileAmmoMax; i++) {
        const mx = vx + 34 + i * 15;
        if (mx > vx + vw - 4) break;
        const have = i < ship.missileAmmo;
        ctx.strokeStyle = have ? AMBER : 'rgba(217,164,65,0.25)';
        ctx.fillStyle = have ? (ship.lockedOn ? RED : AMBER) : 'transparent';
        ctx.beginPath(); // missile pip: small diamond
        ctx.moveTo(mx, vy - 5);
        ctx.lineTo(mx + 4, vy);
        ctx.lineTo(mx, vy + 5);
        ctx.lineTo(mx - 4, vy);
        ctx.closePath();
        if (have) ctx.fill();
        ctx.stroke();
      }
    }

    // ---- corner holo panels ----
    const pw = Math.min(252, Math.max(200, W * 0.19));
    const ph = 128;
    if (this.mobile) {
      // phones: chromeless HUD text with a soft dark glow so it stays
      // readable over bright backdrops. The target block lifts above the
      // ◀ROLL button; the status block moves top-left under the NAV/SYS
      // menus — its desktop corner is taken by the vitals stack (#13),
      // the throttle slider and the FIRE cluster.
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 5;
      this.drawTargetPanel(world, ship, 8, H - ph - 88, pw, ph);
      this.drawStatusPanel(world, ship, 10, 80, pw, ph);
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
      const rel = vsub(pos, ship.pos);
      const d = vlen(rel);
      if (d > range || d < 1) return;
      const nd = Math.sqrt(d / range); // sqrt scale spreads nearby contacts
      const fr = vdot(rel, fwd) / d;
      const ri = vdot(rel, rightAxis) / d;
      const up = vdot(rel, upAxis) / d;
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
      if (e.kind === 'ship') color = e.derelict ? '#7a8a82' : !resolved ? GRAY : e.pirate ? RED : e.isPlayer ? GREEN : CYAN;
      else if (e.kind === 'asteroid') color = 'rgba(140,140,150,0.45)';
      else if (e.kind === 'loot') color = '#d8c46a';
      else if (e.kind === 'fragment') color = '#9ab3a0';
      else if (e.kind === 'missile') color = RED;
      else if (e.kind === 'bolt') continue;
      // capitals paint as heavy square returns, like structures
      blip(e.pos, color, e.kind === 'ship' && e.capital, e.id === ship.targetId);
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
  private panelFrame(x: number, y: number, w: number, h: number, title: string): void {
    if (!this.mobile) {
      this.holoPanel(x, y, w, h, title);
      return;
    }
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(217, 164, 65, 0.5)';
    ctx.font = '9px "Lucida Console", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(title.split('').join(' '), x + 10, y + 10);
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
    ctx.fillStyle = target.kind !== 'ship' ? GRAY
      : target.derelict ? '#7a8a82'
        : !resolved ? GRAY : target.pirate ? RED : target.isPlayer ? GREEN : CYAN;
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
    this.panelFrame(x, y, w, h, 'SHIP STATUS');
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
    let ly = y + (this.mobile ? 26 : 32);
    const step = this.mobile ? 15 : 17;
    for (const [k, v, color] of lines) {
      ctx.fillStyle = AMBER_DIM;
      ctx.fillText(k, x + 10, ly);
      ctx.fillStyle = color;
      ctx.fillText(v, x + 60, ly);
      ly += step;
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

  // segmented gauge: reads at a glance as 'how many blocks left' (#13)
  private segBar(x: number, y: number, w: number, h: number, frac: number, segments: number, color: string): void {
    const ctx = this.ctx;
    const gap = 2;
    const segW = (w - gap * (segments - 1)) / segments;
    const f = Math.max(0, Math.min(1, frac));
    for (let i = 0; i < segments; i++) {
      const sx = x + i * (segW + gap);
      const segFill = Math.max(0, Math.min(1, f * segments - i));
      ctx.strokeStyle = 'rgba(217, 164, 65, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx, y, segW, h);
      if (segFill > 0) {
        ctx.fillStyle = color;
        ctx.fillRect(sx + 1, y + 1, (segW - 2) * segFill, h - 2);
      }
    }
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
