// System map: top-down XZ chart with zoom/pan, object picking and
// Set Destination. Unvisited stations are unlabeled hollow marks — the
// frontier stays dark until you fly it.

import { isMobile } from '../game/mobile';
import { stationInfoCost } from '../sim/system';
import type { Destination, StationDef } from '../sim/types';
import type { IWorld } from '../world_api';
import { button, clearChildren, el, fmtDistance, fmtTime } from './dom';
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
  // touch gesture state: one finger pans, two pinch-zoom, a still tap picks
  private touchPan: { id: number; x: number; y: number; moved: boolean } | null = null;
  private pinchDist = 0;

  private sidebar: HTMLElement;

  constructor(private world: IWorld, private wm: WindowManager, private audio: { click(): void }) {
    const win = wm.register('map', 'SYSTEM CHART — VESPER', true);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vf-map-canvas';
    this.canvas.width = 760;
    this.canvas.height = 560;
    this.ctx = this.canvas.getContext('2d')!;
    const row = el('div', 'vf-map-flex');
    this.sidebar = el('div', 'vf-map-side');
    row.appendChild(this.sidebar);
    const canvasWrap = el('div', 'vf-map-canvaswrap');
    canvasWrap.appendChild(this.canvas);
    row.appendChild(canvasWrap);
    win.body.appendChild(row);
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
    if (isMobile()) {
      // pinch works too, but dedicated buttons are friendlier on small maps
      bar.appendChild(button('−', 'vf-mini', () => this.zoomAtCenter(1 / 1.3)));
      bar.appendChild(button('+', 'vf-mini', () => this.zoomAtCenter(1.3)));
    }
    bar.appendChild(this.setBtn);
    bar.appendChild(clearBtn);
    win.body.appendChild(bar);
    win.refresh = () => {
      this.isOpen = true;
      this.rebuildSidebar();
      this.draw();
    };
    win.onClose = () => {
      this.isOpen = false;
    };

    this.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.zoomAtClient(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.2 : 1 / 1.2);
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
      const [mx, my] = this.toCanvas(ev.clientX, ev.clientY);
      this.pick(mx, my, 18);
    });

    // touch: one-finger pan (a still tap picks), two-finger pinch zoom
    this.canvas.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      if (ev.touches.length === 1) {
        const t = ev.touches[0];
        this.touchPan = { id: t.identifier, x: t.clientX, y: t.clientY, moved: false };
        this.pinchDist = 0;
      } else if (ev.touches.length >= 2) {
        this.touchPan = null;
        this.pinchDist = touchDist(ev.touches);
      }
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (ev) => {
      ev.preventDefault();
      if (ev.touches.length >= 2 && this.pinchDist > 0) {
        const d = touchDist(ev.touches);
        const cx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
        const cy = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        this.zoomAtClient(cx, cy, d / this.pinchDist);
        this.pinchDist = d;
        return;
      }
      const t = this.touchPan && findTouchIn(ev.touches, this.touchPan.id);
      if (!t || !this.touchPan) return;
      const dx = t.clientX - this.touchPan.x;
      const dy = t.clientY - this.touchPan.y;
      if (Math.hypot(dx, dy) > 8) this.touchPan.moved = true;
      // pan in canvas pixels so the chart follows the finger 1:1
      const rect = this.canvas.getBoundingClientRect();
      const k = this.canvas.width / rect.width;
      this.panX += dx * k;
      this.panY += dy * k;
      this.touchPan.x = t.clientX;
      this.touchPan.y = t.clientY;
      this.draw();
    }, { passive: false });
    const touchEnd = (ev: TouchEvent) => {
      ev.preventDefault();
      const tp = this.touchPan;
      if (tp && findTouchIn(ev.changedTouches, tp.id)) {
        this.touchPan = null;
        if (!tp.moved) {
          // ~44px CSS hit area: tap radius widened in canvas pixels
          const [mx, my] = this.toCanvas(tp.x, tp.y);
          this.pick(mx, my, 40);
        }
      }
      if (ev.touches.length < 2) this.pinchDist = 0;
    };
    this.canvas.addEventListener('touchend', touchEnd);
    this.canvas.addEventListener('touchcancel', touchEnd);
  }

  private toCanvas(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [
      (clientX - rect.left) * (this.canvas.width / rect.width),
      (clientY - rect.top) * (this.canvas.height / rect.height),
    ];
  }

  // zoom keeping the given client-space point fixed on screen
  private zoomAtClient(clientX: number, clientY: number, f: number): void {
    const [mx, my] = this.toCanvas(clientX, clientY);
    const z = Math.min(40, Math.max(0.25, this.zoom * f));
    const realF = z / this.zoom;
    this.panX = (mx - this.canvas.width / 2) - (mx - this.canvas.width / 2 - this.panX) * realF;
    this.panY = (my - this.canvas.height / 2) - (my - this.canvas.height / 2 - this.panY) * realF;
    this.zoom = z;
    this.draw();
  }

  private zoomAtCenter(f: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.zoomAtClient(rect.left + rect.width / 2, rect.top + rect.height / 2, f);
  }

  // Sidebar: every station with its services (if known) or a BUY INFO offer
  // priced by distance.
  private rebuildSidebar(): void {
    clearChildren(this.sidebar);
    const ship = this.world.player;
    if (!ship) return;
    const known = new Set(this.world.profile.knownStations);
    this.sidebar.appendChild(el('div', 'vf-map-side-title', 'STATION REGISTRY'));
    const stations = [...this.world.system.stations]
      .sort((a, b) => distTo(ship.pos, a) - distTo(ship.pos, b));
    for (const st of stations) {
      const card = el('div', `vf-map-st${known.has(st.id) ? '' : ' unknown'}`);
      const name = el('div', `vf-map-st-name${st.blackMarket ? ' black' : ''}`, st.name);
      name.addEventListener('click', () => {
        this.selectStation(st);
      });
      card.appendChild(name);
      card.appendChild(el('div', 'vf-map-st-dist', fmtDistance(distTo(ship.pos, st))));
      if (known.has(st.id)) {
        const tags: string[] = [];
        if (st.services.includes('market')) tags.push(st.blackMarket ? 'BLACK MKT' : 'MARKET');
        if (st.services.includes('contracts')) tags.push('JOBS');
        if (st.services.includes('shipyard')) tags.push('SHIPYARD');
        if (st.services.includes('refinery')) tags.push(`REF ${Math.round(st.refineryEff * 100)}%`);
        if (st.services.includes('fuel')) tags.push('FUEL');
        card.appendChild(el('div', 'vf-map-st-svc', tags.join(' · ')));
      } else {
        const cost = stationInfoCost(ship.pos, st);
        const b = button(`BUY INFO (${cost} cr)`, 'vf-mini', () => {
          this.audio.click();
          this.world.buyStationInfo(st.id);
          setTimeout(() => this.rebuildSidebar(), 120);
        });
        if (this.world.profile.credits < cost) b.disabled = true;
        card.appendChild(b);
      }
      this.sidebar.appendChild(card);
    }
  }

  private selectStation(st: StationDef): void {
    this.selected = {
      kind: 'station', id: st.id, name: st.name,
      x: st.pos.x, z: st.pos.z, pos: st.pos, known: true,
    };
    const ship = this.world.player;
    const dist = ship ? distTo(ship.pos, st) : 0;
    const eta = dist / Math.max(1, this.world.shipStats.cruiseMax * 0.6);
    this.info.textContent = `${st.name} — ${fmtDistance(dist)} · ~${fmtTime(eta)} cruise`;
    this.audio.click();
    this.draw();
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
      out.push({ kind: 'station', id: st.id, name: st.name, x: st.pos.x, z: st.pos.z, pos: st.pos, known: known.has(st.id) });
    }
    for (const b of this.world.system.belts) {
      for (const f of b.fields) {
        out.push({ kind: 'field', id: f.id, name: f.name, x: f.pos.x, z: f.pos.z, pos: f.pos, known: true });
      }
    }
    return out;
  }

  private pick(mx: number, my: number, radius: number): void {
    let best: Pickable | null = null;
    let bestD = radius;
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

    // stations: always named; unvisited ones are dimmed until you dock once
    for (const st of this.world.system.stations) {
      const [sx, sy] = this.toScreen(st.pos.x, st.pos.z);
      const isKnown = known.has(st.id);
      const color = st.blackMarket ? '220, 110, 90' : '127, 177, 201';
      ctx.strokeStyle = `rgba(${color}, ${isKnown ? 0.95 : 0.45})`;
      ctx.strokeRect(sx - 4, sy - 4, 8, 8);
      ctx.fillStyle = `rgba(${color}, ${isKnown ? 0.9 : 0.5})`;
      ctx.font = '10px monospace';
      ctx.fillText(isKnown ? st.name : `${st.name} (unvisited)`, sx, sy + 17);
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

function distTo(pos: { x: number; y: number; z: number }, st: StationDef): number {
  return Math.hypot(st.pos.x - pos.x, st.pos.y - pos.y, st.pos.z - pos.z);
}

function touchDist(touches: TouchList): number {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function findTouchIn(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}
