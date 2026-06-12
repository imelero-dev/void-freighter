// Keyboard + mouse input: pointer-locked virtual cursor steers pitch/yaw
// (Freelancer style), keys per the design doc layout.

import type { ShipInput } from '../sim/types';
import { binds } from '../ui/keybinds';
import { settings } from '../ui/settings';

export type GameAction =
  | 'toggleCruise' | 'zeroThrottle' | 'toggleAssist' | 'toggleDrill'
  | 'dock' | 'tab' | 'targetReticle' | 'fireMissile' | 'rescue'
  | 'map' | 'cargo' | 'ship' | 'journal' | 'market' | 'contacts' | 'chat'
  | 'setDestination' | 'escape' | 'toggleCamera' | 'help' | 'controls';

// bind id -> discrete action (axis-style binds are read in frame())
const BIND_ACTIONS: Record<string, GameAction> = {
  cruise: 'toggleCruise', cutThrottle: 'zeroThrottle', assist: 'toggleAssist',
  drill: 'toggleDrill', dock: 'dock', tab: 'tab', reticle: 'targetReticle',
  map: 'map', cargo: 'cargo', ship: 'ship', journal: 'journal',
  market: 'market', contacts: 'contacts', chat: 'chat', dest: 'setDestination',
  camera: 'toggleCamera', rescue: 'rescue', help: 'help',
};

export class InputManager {
  // virtual cursor offset in [-1, 1]
  cursorX = 0;
  cursorY = 0;
  throttle = 0;
  firing = false;
  pointerLocked = false;
  uiMode = false; // true while a window has focus: flight input suspended

  private keys = new Set<string>();
  private listeners = new Map<GameAction, Array<() => void>>();
  private fireListeners: Array<(on: boolean) => void> = [];
  private missileListeners: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (ev) => this.onKeyDown(ev));
    window.addEventListener('keyup', (ev) => this.keys.delete(ev.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('click', () => {
      if (!this.uiMode && !this.pointerLocked) void canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      if (!this.pointerLocked) {
        this.firing = false;
        for (const fn of this.fireListeners) fn(false);
      }
    });
    window.addEventListener('mousemove', (ev) => {
      if (!this.pointerLocked || this.uiMode) return;
      const s = Math.min(window.innerWidth, window.innerHeight) * 0.34 / settings.sensitivity;
      const my = settings.invertY ? -ev.movementY : ev.movementY;
      this.cursorX = clamp(this.cursorX + ev.movementX / s, -1, 1);
      this.cursorY = clamp(this.cursorY + my / s, -1, 1);
    });
    window.addEventListener('mousedown', (ev) => {
      if (!this.pointerLocked || this.uiMode) return;
      if (ev.button === 0) {
        this.firing = true;
        for (const fn of this.fireListeners) fn(true);
      } else if (ev.button === 2) {
        for (const fn of this.missileListeners) fn();
      }
    });
    window.addEventListener('mouseup', (ev) => {
      if (ev.button === 0 && this.firing) {
        this.firing = false;
        for (const fn of this.fireListeners) fn(false);
      }
    });
    window.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  private onKeyDown(ev: KeyboardEvent): void {
    // let the chat input take everything except Escape
    if (this.uiMode && ev.code !== 'Escape' && ev.code !== 'Tab') {
      if (ev.code === 'Enter') this.emit('chat');
      if (ev.code === 'Escape') this.emit('escape');
      return;
    }
    if (ev.code === 'Tab') ev.preventDefault();
    if (ev.code === 'Space') ev.preventDefault();
    if (!ev.repeat) {
      this.keys.add(ev.code);
      if (ev.code === 'Escape') {
        this.emit('escape');
        return;
      }
      if (ev.code === 'F2') {
        this.emit('controls');
        return;
      }
      // dynamic keybinds: find which bound action this key triggers
      for (const [bindId, action] of Object.entries(BIND_ACTIONS)) {
        if (binds[bindId] === ev.code) {
          this.emit(action);
          break;
        }
      }
    }
  }

  on(action: GameAction, fn: () => void): void {
    const list = this.listeners.get(action) ?? [];
    list.push(fn);
    this.listeners.set(action, list);
  }

  // programmatic action dispatch (gamepad buttons, UI shortcuts)
  trigger(action: GameAction): void {
    this.emit(action);
  }

  onFire(fn: (on: boolean) => void): void {
    this.fireListeners.push(fn);
  }

  onMissile(fn: () => void): void {
    this.missileListeners.push(fn);
  }

  private emit(action: GameAction): void {
    for (const fn of this.listeners.get(action) ?? []) fn();
  }

  releasePointer(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  zeroThrottle(): void {
    this.throttle = 0;
  }

  // Build this frame's ShipInput; dt for throttle ramp.
  frame(dt: number, out: ShipInput): void {
    if (this.uiMode) {
      out.thrustForward = this.throttle;
      out.thrustRight = 0;
      out.thrustUp = 0;
      out.pitch = 0;
      out.yaw = 0;
      out.roll = 0;
      out.brake = false;
      out.turbo = false;
      return;
    }
    const k = (code: string) => this.keys.has(code);
    const b = (bindId: string) => binds[bindId] !== '' && k(binds[bindId]);
    // gradual throttle: bound keys plus Shift/Ctrl legacy extras; holding
    // throttle-down past zero brakes
    const up = b('throttleUp') || k('ShiftLeft') || k('ShiftRight');
    const down = b('throttleDown') || k('ControlLeft') || k('ControlRight');
    if (up) this.throttle = clamp(this.throttle + dt * 0.8, -0.3, 1);
    if (down) this.throttle = clamp(this.throttle - dt * 0.8, -0.3, 1);
    out.thrustForward = this.throttle;
    // pinned at 100% and still pushing -> turbo overburn
    out.turbo = up && this.throttle >= 1;
    out.thrustRight = (b('strafeRight') ? 1 : 0) - (b('strafeLeft') ? 1 : 0);
    out.thrustUp = (b('strafeUp') ? 1 : 0) - (b('strafeDown') ? 1 : 0);
    out.roll = (b('rollRight') ? 1 : 0) - (b('rollLeft') ? 1 : 0);
    out.brake = down && this.throttle <= 0.02;
    // virtual cursor with a small deadzone and smooth curve
    const dead = 0.04;
    const curve = (v: number) => {
      const a = Math.abs(v);
      if (a < dead) return 0;
      const t = (a - dead) / (1 - dead);
      return Math.sign(v) * t * t * (3 - 2 * t);
    };
    out.yaw = -curve(this.cursorX);
    out.pitch = -curve(this.cursorY);
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
