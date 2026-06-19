// Touch controls for phones/tablets: floating look stick (left thumb),
// absolute throttle slider, fire/secondary hold buttons and two collapsible
// NAV/SYS action menus in the top-left corner (ROLL holds stay at the bottom
// corners). Pure DOM overlay in the amber HUD style; it writes straight into
// the InputManager so the sim keeps seeing a single input source.

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
const STRAFE_ENGAGE = 22;  // px of drag off a ROLL button before strafe kicks in
const STRAFE_RANGE = 70;   // px of drag for full strafe deflection

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
  private docked = false;
  private popovers: HTMLElement[] = [];
  private strafeResets: Array<() => void> = [];

  constructor(private input: InputManager) {
    this.root = this.build();
    document.body.appendChild(this.root);
    // all geometry is CSS-driven; on rotation/resize just drop any touches
    // mid-gesture (their coordinates no longer mean anything)
    window.addEventListener('resize', this.onLayoutChange);
    window.addEventListener('orientationchange', this.onLayoutChange);
    // capture phase so a tap anywhere outside an open menu closes it before
    // whatever it landed on handles the touch
    document.addEventListener('touchstart', this.onDocTouch, true);
  }

  private onLayoutChange = () => this.releaseAll();

  setVisible(on: boolean): void {
    this.visible = on;
    this.applyVisibility();
  }

  // docked: the dockbar covers the top of the screen and has every service
  // plus UNDOCK — flight controls would sit dead underneath it
  setDocked(on: boolean): void {
    if (this.docked === on) return;
    this.docked = on;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const show = this.visible && !this.docked;
    this.root.style.display = show ? '' : 'none';
    if (!show) this.releaseAll();
  }

  destroy(): void {
    window.removeEventListener('resize', this.onLayoutChange);
    window.removeEventListener('orientationchange', this.onLayoutChange);
    document.removeEventListener('touchstart', this.onDocTouch, true);
    this.releaseAll();
    this.root.remove();
  }

  // ---------------------------------------------------------------------

  private build(): HTMLElement {
    const root = el('div');
    root.id = 'vf-touch';
    this.popovers = [];
    this.strafeResets = [];

    // top-left: two collapsed menus replace the old top/bottom button strips
    const menus = el('div', 'vf-touch-menus');
    menus.appendChild(this.menuButton('NAV ▾', [
      ['MAP', 'map'], ['CARGO', 'cargo'], ['SHIP', 'ship'], ['JRNL', 'journal'],
    ]));
    menus.appendChild(this.menuButton('SYS ▾', [
      ['CRUISE', 'toggleCruise'], ['VTOL', 'toggleVtol'], ['GEAR', 'toggleGear'],
      ['DOCK', 'dock'], ['AUTODOCK', 'autodock'], ['DRILL', 'toggleDrill'],
      ['ASSIST', 'toggleAssist'], ['LIGHTS', 'lights'], ['CAM', 'toggleCamera'],
    ]));
    root.appendChild(menus);

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

    // roll holds stay pinned to the bottom corners: they are held through
    // whole maneuvers, a popover would be unworkable. Dragging off them
    // turns the hold into a strafe mini-stick (issue #1).
    const rollL = this.rollButton('◀ROLL', (on) => { this.input.touchRollLeft = on; });
    rollL.classList.add('vf-touch-roll-l');
    root.appendChild(rollL);
    const rollR = this.rollButton('ROLL▶', (on) => { this.input.touchRollRight = on; });
    rollR.classList.add('vf-touch-roll-r');
    root.appendChild(rollR);
    return root;
  }

  // Hold = roll, drag past STRAFE_ENGAGE = strafe stick centered on the
  // touch-down point (right/left = lateral, up/down = vertical). Once strafe
  // engages it stays engaged until release so the mode never flaps.
  private rollButton(label: string, setRoll: (on: boolean) => void): HTMLButtonElement {
    const b = el('button', 'vf-touch-btn', label);
    let id: number | null = null;
    let ox = 0;
    let oy = 0;
    let strafing = false;
    const reset = () => {
      id = null;
      strafing = false;
      b.classList.remove('held');
      b.textContent = label;
      setRoll(false);
      this.input.touchStrafeX = 0;
      this.input.touchStrafeY = 0;
    };
    this.strafeResets.push(reset);
    b.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      if (id !== null) return;
      const t = ev.changedTouches[0];
      id = t.identifier;
      ox = t.clientX;
      oy = t.clientY;
      b.classList.add('held');
      setRoll(true);
    }, { passive: false });
    b.addEventListener('touchmove', (ev) => {
      ev.preventDefault();
      const t = findTouch(ev.changedTouches, id);
      if (!t) return;
      const dx = t.clientX - ox;
      const dy = t.clientY - oy;
      if (!strafing && Math.hypot(dx, dy) > STRAFE_ENGAGE) {
        strafing = true;
        setRoll(false);
        b.textContent = '✛ STRAFE';
      }
      if (strafing) {
        this.input.touchStrafeX = clamp(dx / STRAFE_RANGE, -1, 1);
        this.input.touchStrafeY = clamp(-dy / STRAFE_RANGE, -1, 1);
      }
    }, { passive: false });
    const up = (ev: TouchEvent) => {
      if (!findTouch(ev.changedTouches, id)) return;
      reset();
    };
    b.addEventListener('touchend', up);
    b.addEventListener('touchcancel', up);
    return b;
  }

  // collapsed menu button + its popover; only one popover open at a time
  private menuButton(label: string, actions: Array<[string, GameAction]>): HTMLElement {
    const wrap = el('div', 'vf-touch-menu');
    const btn = el('button', 'vf-touch-menubtn', label);
    const pop = el('div', 'vf-touch-popover');
    for (const [l, action] of actions) {
      pop.appendChild(this.tapButton(l, () => {
        this.input.trigger(action);
        this.closePopovers();
      }));
    }
    btn.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      const wasOpen = pop.classList.contains('open');
      this.closePopovers();
      if (!wasOpen) pop.classList.add('open');
    }, { passive: false });
    wrap.appendChild(btn);
    wrap.appendChild(pop);
    this.popovers.push(pop);
    return wrap;
  }

  private closePopovers(): void {
    for (const p of this.popovers) p.classList.remove('open');
  }

  private onDocTouch = (ev: TouchEvent) => {
    const t = ev.target;
    if (!(t instanceof Element) || !t.closest('.vf-touch-menu')) this.closePopovers();
  };

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
    // same scale as the mouse cursor; thumbs get their own multiplier
    // ("Touch sensitivity" in SETTINGS, issue #6)
    const s = Math.min(window.innerWidth, window.innerHeight) * 0.34 / settings.touchSens;
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
    if (!t && ev.type === 'touchstart' && this.throttleId === null) {
      t = ev.changedTouches[0];
      this.throttleId = t.identifier;
    }
    if (!t) return;
    const rect = this.throttleEl.getBoundingClientRect();
    const raw = clamp(1 - (t.clientY - rect.top) / rect.height, 0, 1);
    // top ~7% of the slider is a spring-loaded BOOST band: full throttle +
    // turbo while held there; the lower 93% maps to the 0..1 throttle range
    if (raw > 0.93) {
      this.input.throttle = 1;
      this.input.mobileBoost = true;
      this.throttleEl.classList.add('boosting');
    } else {
      this.input.throttle = raw / 0.93;
      this.input.mobileBoost = false;
      this.throttleEl.classList.remove('boosting');
    }
  };

  private onThrottleEnd = (ev: TouchEvent) => {
    if (findTouch(ev.changedTouches, this.throttleId)) {
      this.throttleId = null;
      this.input.mobileBoost = false;
      this.throttleEl.classList.remove('boosting');
    }
  };

  // ----- per-frame upkeep --------------------------------------------------

  // Driven by GameApp's render loop (no rAF of its own): throttle bar sync
  // and the look-stick recenter glide.
  update(dt: number): void {
    if (!this.visible || this.docked) return;
    // bar tracks the live value (keyboard ramp / cut-throttle move it too)
    this.throttleFill.style.height = `${Math.round(clamp(this.input.throttle, 0, 1) * 100)}%`;
    if (this.lookId === null && this.recenterLeft > 0) {
      this.recenterLeft = Math.max(0, this.recenterLeft - dt);
      const t = this.recenterLeft / RECENTER_S; // 1 -> 0
      const e = t * t * (3 - 2 * t);
      this.input.cursorX = this.recenterFromX * e;
      this.input.cursorY = this.recenterFromY * e;
    }
  }

  private releaseAll(): void {
    this.closePopovers();
    this.lookId = null;
    this.throttleId = null;
    this.recenterLeft = 0;
    this.input.cursorX = 0;
    this.input.cursorY = 0;
    this.input.fireOn(false);
    this.input.rmbOn(false);
    this.input.mobileBoost = false;
    this.throttleEl?.classList.remove('boosting');
    this.input.touchRollLeft = false;
    this.input.touchRollRight = false;
    for (const reset of this.strafeResets) reset();
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
