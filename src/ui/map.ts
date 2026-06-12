// System map: top-down XZ chart with zoom/pan, object picking and
// Set Destination. Unvisited stations are unlabeled hollow marks — the
// frontier stays dark until you fly it.

import type { Destination } from '../sim/types';
import type { IWorld } from '../world_api';
import { button, el, fmtDistance, fmtTime } from './dom';
import type { WindowManager } from './windows';

interface Pickable {
  kind: Destination['kind'];
  id: string;
  name: string;
  x: number;
  z: number;
  pos: { x: number; y: number; z: number };
  known: boolean;
}

export class SystemMap {
  isOpen = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private info: HTMLElement;
  private setBtn: HTMLButtonElement;
  private zoom = 1;     // px per Mm baseline factor
  private panX = 0;
  private panY = 0;
  private selected: Pickable | null = null;
  private dragging = false;

  constructor(private world: IWorld, private wm: WindowManager, private audio: { click(): void }) {
    const win = wm.register('map', 'SYSTEM CHART — VESPER', true);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vf-map-canvas';
    this.canvas.width = 860;
    this.canvas.height = 560;
    this.ctx = this.canvas.getContext('2d')!;
    win.body.appendChild(this.canvas);
    const bar = el('div', 'vf-map-bar');
    this.info = el('span', 'vf-map-info', 'Click a marker to select it.');
    this.setBtn = button('SET DESTINATION [N]', 'vf-btn accept', () => {
      if (!this.selected) return;
      this.audio.click();
      this.world.setDestination({
        kind: this.selected.kind, id: this.selected.id,
        name: this.selected.name, pos: { ...this.selected.pos },
      });
    });
    const clearBtn = button('CLEAR', 'vf-btn', () => {
      this.audio.click();
      this.world.setDestination(null);
    });
    bar.appendChild(this.info);
    bar.appendChild(this.setBtn);
    bar.appendChild(clearBtn);
    win.body.appendChild(bar);
    win.refresh = () => {
      this.isOpen = true;
      this.draw();
    };
    win.onClose = () => {
      this.isOpen = false;
    };

    this.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const f = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.zoom = Math.min(40, Math.max(0.25, this.zoom * f));
      this.draw();
    });
    this.canvas.addEventListener('mousedown', () => {
      this.dragging = false;
    });
    this.canvas.addEventListener('mousemove', (ev) => {
      if (ev.buttons === 1) {
        this.dragging = true;
        this.panX += ev.movementX;
        this.panY += ev.movementY;
        this.draw();
      }
    });
    this.canvas.addEventListener('click', (ev) => {
      if (this.dragging) {
        this.dragging = false;
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const mx = (ev.clientX - rect.left) * (this.canvas.width / rect.width);
      const my = (ev.clientY - rect.top) * (this.canvas.height / rect.height);
      this.pick(mx, my);
    });
  }

  private scale(): number {
    // px per meter
    return (this.canvas.height / 2 / 5.2e7) * this.zoom;
  }

  private toScreen(x: number, z: number): [number, number] {
    const s = this.scale();
    return [this.canvas.width / 2 + x * s + this.panX, this.canvas.height / 2 + z * s + this.panY];
  }

  private pickables(): Pickable[] {
    const known = new Set(this.world.profile.knownStations);
    const out: Pickable[] = [];
    for (const p of this.world.system.planets) {
      out.push({ kind: 'planet', id: p.id, name: p.name, x: p.pos.x, z: p.pos.z, pos: p.pos, known: true });
    }
    for (const st of this.world.system.stations) {
      out.push({ kind: 'station', id: st.id, name: known.has(st.id) ? st.name : 'Unknown signal', x: st.pos.x, z: st.pos.z, pos: st.pos, known: known.has(st.id) });
    }
    for (const b of this.world.system.belts) {
      for (const f of b.fields) {
        out.push({ kind: 'field', id: f.id, name: f.name, x: f.pos.x, z: f.pos.z, pos: f.pos, known: true });
      }
    }
    return out;
  }

  private pick(mx: number, my: number): void {
    let best: Pickable | null = null;
    let bestD = 18;
    for (const p of this.pickables()) {
      const [sx, sy] = this.toScreen(p.x, p.z);
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    this.selected = best;
    if (best) {
      const ship = this.world.player;
      const dist = ship ? Math.hypot(best.pos.x - ship.pos.x, best.pos.y - ship.pos.y, best.pos.z - ship.pos.z) : 0;
      const eta = dist / Math.max(1, this.world.shipStats.cruiseMax * 0.6);
      const danger = this.world.dangerAt(best.pos);
      const dangerTxt = danger > 0.55 ? ' · ☠ RED ZONE' : danger > 0.25 ? ' · ⚠ unsafe' : '';
      this.info.textContent = `${best.name} — ${fmtDistance(dist)} · ~${fmtTime(eta)} cruise${dangerTxt}`;
      this.audio.click();
    } else {
      this.info.textContent = 'Click a marker to select it.';
    }
    this.draw();
  }

  // select programmatically (N key with a target)
  externalSelect(): Pickable | null {
    return this.selected;
  }

  draw(): void {
    if (!this.isOpen) return;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, W, H);
    const s = this.scale();
    const known = new Set(this.world.profile.knownStations);

    // grid rings every 10 Mm
    ctx.strokeStyle = 'rgba(120, 140, 160, 0.07)';
    for (let r = 1e7; r <= 5e7; r += 1e7) {
      const [cx, cy] = this.toScreen(0, 0);
      ctx.beginPath();
      ctx.arc(cx, cy, r * s, 0, Math.PI * 2);
      ctx.stroke();
    }

    // belts as broad rings with field markers
    for (const b of this.world.system.belts) {
      const [cx, cy] = this.toScreen(0, 0);
      ctx.strokeStyle = `rgba(170, 120, 80, ${0.10 + b.danger * 0.12})`;
      ctx.lineWidth = Math.max(2, 1.4e6 * s);
      ctx.beginPath();
      ctx.arc(cx, cy, b.ringRadius * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
      for (const f of b.fields) {
        const [fx, fy] = this.toScreen(f.pos.x, f.pos.z);
        // danger halo
        if (f.danger > 0.25) {
          ctx.fillStyle = `rgba(220, 60, 30, ${f.danger * 0.22})`;
          ctx.beginPath();
          ctx.arc(fx, fy, 9 + f.danger * 8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#9a8a70';
        ctx.fillRect(fx - 2, fy - 2, 4, 4);
        if (this.zoom > 0.6) {
          ctx.fillStyle = 'rgba(170, 150, 120, 0.6)';
          ctx.font = '10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(f.name, fx, fy + 14);
        }
      }
    }

    // star
    {
      const [cx, cy] = this.toScreen(0, 0);
      ctx.fillStyle = '#ffb050';
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 176, 80, 0.7)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('VESPER', cx, cy + 18);
    }

    // planets
    for (const p of this.world.system.planets) {
      const [px, py] = this.toScreen(p.pos.x, p.pos.z);
      ctx.fillStyle = '#7d8a96';
      ctx.beginPath();
      ctx.arc(px, py, 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(160, 180, 200, 0.85)';
      ctx.font = '11px monospace';
      ctx.fillText(p.name.toUpperCase(), px, py - 10);
    }

    // stations
    for (const st of this.world.system.stations) {
      const [sx, sy] = this.toScreen(st.pos.x, st.pos.z);
      const isKnown = known.has(st.id);
      ctx.strokeStyle = isKnown ? (st.blackMarket ? '#cc5544' : '#7fb1c9') : 'rgba(130, 140, 150, 0.5)';
      ctx.strokeRect(sx - 4, sy - 4, 8, 8);
      if (isKnown) {
        ctx.fillStyle = st.blackMarket ? 'rgba(220, 110, 90, 0.9)' : 'rgba(127, 177, 201, 0.9)';
        ctx.font = '10px monospace';
        ctx.fillText(st.name, sx, sy + 17);
      } else {
        ctx.fillStyle = 'rgba(130, 140, 150, 0.45)';
        ctx.font = '10px monospace';
        ctx.fillText('?', sx, sy + 17);
      }
    }

    // destination
    const dest = this.world.destination;
    if (dest) {
      const [dx, dy] = this.toScreen(dest.pos.x, dest.pos.z);
      ctx.strokeStyle = '#d9a441';
      ctx.beginPath();
      ctx.moveTo(dx, dy - 9);
      ctx.lineTo(dx + 9, dy);
      ctx.lineTo(dx, dy + 9);
      ctx.lineTo(dx - 9, dy);
      ctx.closePath();
      ctx.stroke();
      // route line from player
      const ship = this.world.player;
      if (ship) {
        const [px, py] = this.toScreen(ship.pos.x, ship.pos.z);
        ctx.strokeStyle = 'rgba(217, 164, 65, 0.4)';
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(dx, dy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // selection
    if (this.selected) {
      const [sx, sy] = this.toScreen(this.selected.x, this.selected.z);
      ctx.strokeStyle = '#d9a441';
      ctx.beginPath();
      ctx.arc(sx, sy, 11, 0, Math.PI * 2);
      ctx.stroke();
    }

    // player
    const ship = this.world.player;
    if (ship) {
      const [px, py] = this.toScreen(ship.pos.x, ship.pos.z);
      ctx.fillStyle = '#7fc97f';
      ctx.beginPath();
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px + 5, py + 5);
      ctx.lineTo(px - 5, py + 5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(127, 201, 127, 0.8)';
      ctx.font = '10px monospace';
      ctx.fillText('YOU', px, py - 11);
    }

    ctx.fillStyle = 'rgba(150, 160, 170, 0.5)';
    ctx.textAlign = 'left';
    ctx.font = '10px monospace';
    ctx.fillText('wheel: zoom · drag: pan · click: select', 10, H - 10);
  }
}
