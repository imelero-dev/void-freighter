// Touch controls for phones/tablets: floating look stick (left thumb),
// absolute throttle slider, fire/secondary hold buttons and an action bar.
// Pure DOM overlay in the amber HUD style; it writes straight into the
// InputManager so the sim keeps seeing a single input source.

import { el } from '../ui/dom';
import { settings } from '../ui/settings';
import type { GameAction, InputManager } from './input';

// Touch screen and no fine pointer (mouse) -> phone/tablet. Guarded so it can
// be evaluated headless (vitest / node) where there is no DOM at all.
export function isMobile(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const touch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  if (!touch) return false;
  const fine = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
  return !fine;
}

const NUB_RADIUS = 80;     // max visual stick deflection, px
const RECENTER_S = 0.15;   // cursor glide back to center after release

export class TouchControls {
  private root: HTMLElement;
  private lookZone!: HTMLElement;
  private stickBase!: HTMLElement;
  private nub!: HTMLElement;
  private throttleEl!: HTMLElement;
  private throttleFill!: HTMLElement;
  private lookId: number | null = null;
  private lookOx = 0;
  private lookOy = 0;
  private throttleId: number | null = null;
  private recenterLeft = 0;   // seconds of glide remaining
  private recenterFromX = 0;
  private recenterFromY = 0;
  private visible = true;
  private raf = 0;
  private lastT = 0;

  constructor(private input: InputManager) {
    this.root = this.build();
    document.body.appendChild(this.root);
    // zone geometry depends on the viewport: rebuild on rotation/resize
    window.addEventListener('resize', this.onLayoutChange);
    window.addEventListener('orientationchange', this.onLayoutChange);
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private onLayoutChange = () => this.rebuild();

  rebuild(): void {
    this.releaseAll();
    this.root.remove();
    this.root = this.build();
    this.root.style.display = this.visible ? '' : 'none';
    document.body.appendChild(this.root);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.style.display = on ? '' : 'none';
    if (!on) this.releaseAll();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onLayoutChange);
    window.removeEventListener('orientationchange', this.onLayoutChange);
    this.releaseAll();
    this.root.remove();
  }

  // ---------------------------------------------------------------------

  private build(): HTMLElement {
    const root = el('div');
    root.id = 'vf-touch';

    // top strip: window toggles
    const top = el('div', 'vf-touch-top');
    const topActions: Array<[string, GameAction]> = [
      ['MAP', 'map'], ['CARGO', 'cargo'], ['SHIP', 'ship'], ['JRNL', 'journal'],
    ];
    for (const [label, action] of topActions) {
      top.appendChild(this.tapButton(label, () => this.input.trigger(action)));
    }
    root.appendChild(top);

    // look zone (left thumb): floating joystick drives the virtual cursor
    this.lookZone = el('div', 'vf-touch-look');
    this.lookZone.addEventListener('touchstart', this.onLookStart, { passive: false });
    this.lookZone.addEventListener('touchmove', this.onLookMove, { passive: false });
    this.lookZone.addEventListener('touchend', this.onLookEnd);
    this.lookZone.addEventListener('touchcancel', this.onLookEnd);
    root.appendChild(this.lookZone);
    this.stickBase = el('div', 'vf-touch-stickbase');
    this.nub = el('div', 'vf-touch-nub');
    root.appendChild(this.stickBase);
    root.appendChild(this.nub);

    // throttle slider: position inside the strip = absolute throttle
    this.throttleEl = el('div', 'vf-touch-throttle');
    this.throttleEl.appendChild(el('div', 'vf-touch-throttle-label', 'THR'));
    this.throttleFill = el('div', 'vf-touch-throttle-fill');
    this.throttleEl.appendChild(this.throttleFill);
    this.throttleEl.addEventListener('touchstart', this.onThrottle, { passive: false });
    this.throttleEl.addEventListener('touchmove', this.onThrottle, { passive: false });
    this.throttleEl.addEventListener('touchend', this.onThrottleEnd);
    this.throttleEl.addEventListener('touchcancel', this.onThrottleEnd);
    root.appendChild(this.throttleEl);

    // right thumb: primary fire + secondary (missile / mining beam)
    const fire = this.holdButton('FIRE', (on) => {
      if (!on || !this.input.uiMode) this.input.fireOn(on);
    });
    fire.classList.add('vf-touch-fire');
    root.appendChild(fire);
    const sec = this.holdButton('MSL·BEAM', (on) => {
      if (!on || !this.input.uiMode) this.input.rmbOn(on);
    });
    sec.classList.add('vf-touch-secondary');
    root.appendChild(sec);

    // bottom bar: roll holds + discrete actions
    const bottom = el('div', 'vf-touch-bottom');
    bottom.appendChild(this.holdButton('◀ROLL', (on) => { this.input.touchRollLeft = on; }));
    const bottomActions: Array<[string, GameAction]> = [
      ['CRUISE', 'toggleCruise'], ['DOCK', 'dock'], ['DRILL', 'toggleDrill'],
      ['ASSIST', 'toggleAssist'], ['LIGHTS', 'lights'], ['CAM', 'toggleCamera'],
    ];
    for (const [label, action] of bottomActions) {
      bottom.appendChild(this.tapButton(label, () => this.input.trigger(action)));
    }
    bottom.appendChild(this.holdButton('ROLL▶', (on) => { this.input.touchRollRight = on; }));
    root.appendChild(bottom);
    return root;
  }

  private tapButton(label: string, fn: () => void): HTMLButtonElement {
    const b = el('button', 'vf-touch-btn', label);
    b.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      b.classList.add('held');
      fn();
    }, { passive: false });
    const up = () => b.classList.remove('held');
    b.addEventListener('touchend', up);
    b.addEventListener('touchcancel', up);
    return b;
  }

  private holdButton(label: string, set: (on: boolean) => void): HTMLButtonElement {
    const b = el('button', 'vf-touch-btn', label);
    b.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      b.classList.add('held');
      set(true);
    }, { passive: false });
    const up = () => {
      b.classList.remove('held');
      set(false);
    };
    b.addEventListener('touchend', up);
    b.addEventListener('touchcancel', up);
    return b;
  }

  // ----- look stick -------------------------------------------------------

  private onLookStart = (ev: TouchEvent) => {
    ev.preventDefault();
    if (this.input.uiMode || this.lookId !== null) return;
    const t = ev.changedTouches[0];
    this.lookId = t.identifier;
    this.lookOx = t.clientX;
    this.lookOy = t.clientY;
    this.recenterLeft = 0;
    this.placeStick(this.stickBase, this.lookOx, this.lookOy);
    this.placeStick(this.nub, this.lookOx, this.lookOy);
    this.stickBase.style.display = 'block';
    this.nub.style.display = 'block';
  };

  private onLookMove = (ev: TouchEvent) => {
    ev.preventDefault();
    const t = findTouch(ev.changedTouches, this.lookId);
    if (!t) return;
    const dx = t.clientX - this.lookOx;
    const dy = t.clientY - this.lookOy;
    // nub clamped to the base radius
    const len = Math.hypot(dx, dy);
    const k = len > NUB_RADIUS ? NUB_RADIUS / len : 1;
    this.placeStick(this.nub, this.lookOx + dx * k, this.lookOy + dy * k);
    // same scale as the mouse cursor, ×1.5 sensitivity for thumbs
    const s = Math.min(window.innerWidth, window.innerHeight) * 0.34 / (settings.sensitivity * 1.5);
    const my = settings.invertY ? -dy : dy;
    this.input.cursorX = clamp(dx / s, -1, 1);
    this.input.cursorY = clamp(my / s, -1, 1);
  };

  private onLookEnd = (ev: TouchEvent) => {
    if (!findTouch(ev.changedTouches, this.lookId)) return;
    this.lookId = null;
    this.stickBase.style.display = 'none';
    this.nub.style.display = 'none';
    // glide back to center instead of snapping
    this.recenterFromX = this.input.cursorX;
    this.recenterFromY = this.input.cursorY;
    this.recenterLeft = RECENTER_S;
  };

  private placeStick(node: HTMLElement, x: number, y: number): void {
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  }

  // ----- throttle ----------------------------------------------------------

  private onThrottle = (ev: TouchEvent) => {
    ev.preventDefault();
    if (this.input.uiMode) return;
    let t = findTouch(ev.changedTouches, this.throttleId);
    if (!t && ev.type === 'touchstart') {
      t = ev.changedTouches[0];
      this.throttleId = t.identifier;
    }
    if (!t) return;
    const rect = this.throttleEl.getBoundingClientRect();
    this.input.throttle = clamp(1 - (t.clientY - rect.top) / rect.height, 0, 1);
  };

  private onThrottleEnd = (ev: TouchEvent) => {
    if (findTouch(ev.changedTouches, this.throttleId)) this.throttleId = null;
  };

  // ----- per-frame upkeep --------------------------------------------------

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastT) / 1000); // same clamp as the main loop
    this.lastT = now;
    if (!this.visible) return;
    // bar tracks the live value (keyboard ramp / cut-throttle move it too)
    this.throttleFill.style.height = `${Math.round(clamp(this.input.throttle, 0, 1) * 100)}%`;
    if (this.lookId === null && this.recenterLeft > 0) {
      this.recenterLeft = Math.max(0, this.recenterLeft - dt);
      const t = this.recenterLeft / RECENTER_S; // 1 -> 0
      const e = t * t * (3 - 2 * t);
      this.input.cursorX = this.recenterFromX * e;
      this.input.cursorY = this.recenterFromY * e;
    }
  };

  private releaseAll(): void {
    this.lookId = null;
    this.throttleId = null;
    this.recenterLeft = 0;
    this.input.cursorX = 0;
    this.input.cursorY = 0;
    this.input.fireOn(false);
    this.input.rmbOn(false);
    this.input.touchRollLeft = false;
    this.input.touchRollRight = false;
    this.stickBase.style.display = 'none';
    this.nub.style.display = 'none';
  }
}

function findTouch(list: TouchList, id: number | null): Touch | null {
  if (id === null) return null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
