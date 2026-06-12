// HOTAS / gamepad support via the browser Gamepad API. Layouts vary wildly
// between sticks (T16000M, X52, VKB, plain pads…), so everything is bound by
// capture: "move the axis you want for pitch", "press the button for fire".

import type { ShipInput } from '../sim/types';
import { hotas, saveHotas, type HotasAxis, type HotasButton } from '../ui/keybinds';
import type { GameAction } from './input';

const DEADZONE = 0.10;

export interface GamepadFrame {
  actions: GameAction[];       // edge-triggered discrete actions
  fire: boolean | null;        // hold-state (null = no fire button bound)
  missile: boolean;            // edge
}

const BUTTON_ACTION: Partial<Record<HotasButton, GameAction>> = {
  cruise: 'toggleCruise', dock: 'dock', tab: 'tab', drill: 'toggleDrill',
};

export class GamepadManager {
  deviceName: string | null = null;
  private prevButtons: boolean[] = [];
  private axisCapture: ((index: number, invert: boolean) => void) | null = null;
  private buttonCapture: ((index: number) => void) | null = null;
  private axisRest: number[] | null = null;

  constructor() {
    window.addEventListener('gamepadconnected', (ev) => {
      this.deviceName = (ev as GamepadEvent).gamepad.id;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.deviceName = null;
    });
  }

  private pad(): Gamepad | null {
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (gp && gp.connected) return gp;
    }
    return null;
  }

  // Start capture flows (driven from the controls window)
  captureAxis(cb: (index: number, invert: boolean) => void): void {
    const gp = this.pad();
    this.axisRest = gp ? [...gp.axes] : null;
    this.axisCapture = cb;
    this.buttonCapture = null;
  }

  captureButton(cb: (index: number) => void): void {
    this.buttonCapture = cb;
    this.axisCapture = null;
  }

  cancelCapture(): void {
    this.axisCapture = null;
    this.buttonCapture = null;
  }

  // Poll once per frame: apply bound axes to the ship input and collect
  // edge-triggered button actions.
  apply(input: ShipInput, setThrottle: (v: number) => void): GamepadFrame {
    const out: GamepadFrame = { actions: [], fire: null, missile: false };
    const gp = this.pad();
    if (!gp) return out;
    this.deviceName = gp.id;

    // capture flows take priority
    if (this.axisCapture) {
      if (!this.axisRest) this.axisRest = [...gp.axes];
      for (let i = 0; i < gp.axes.length; i++) {
        const delta = gp.axes[i] - (this.axisRest[i] ?? 0);
        if (Math.abs(delta) > 0.5) {
          const cb = this.axisCapture;
          this.axisCapture = null;
          // moving "up/forward" usually reads negative — invert so positive = up
          cb(i, delta > 0);
          break;
        }
      }
      return out;
    }
    if (this.buttonCapture) {
      for (let i = 0; i < gp.buttons.length; i++) {
        if (gp.buttons[i].pressed && !this.prevButtons[i]) {
          const cb = this.buttonCapture;
          this.buttonCapture = null;
          cb(i);
          break;
        }
      }
      this.prevButtons = gp.buttons.map((b) => b.pressed);
      return out;
    }

    // axes
    const axis = (name: HotasAxis): number | null => {
      const bind = hotas.axes[name];
      if (!bind || bind.index >= gp.axes.length) return null;
      let v = gp.axes[bind.index];
      if (bind.invert) v = -v;
      return Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
    };
    const pitch = axis('pitch');
    const yaw = axis('yaw');
    const roll = axis('roll');
    // stick overrides mouse when deflected
    if (pitch !== null && pitch !== 0) input.pitch = clamp1(-pitch);
    if (yaw !== null && yaw !== 0) input.yaw = clamp1(-yaw);
    if (roll !== null && roll !== 0) input.roll = clamp1(roll);
    const thrBind = hotas.axes.throttle;
    if (thrBind && thrBind.index < gp.axes.length) {
      let v = gp.axes[thrBind.index];
      if (thrBind.invert) v = -v;
      const mapped = clamp1((1 - v) / 2); // -1..1 -> 1..0 -> throttle 0..1
      input.thrustForward = mapped;
      setThrottle(mapped); // keep the keyboard ramp in sync
      input.turbo = mapped >= 0.995 && (hotas.buttons.turbo === undefined);
    }

    // buttons
    for (const [name, idx] of Object.entries(hotas.buttons) as Array<[HotasButton, number]>) {
      if (idx === undefined || idx >= gp.buttons.length) continue;
      const pressed = gp.buttons[idx].pressed;
      const was = this.prevButtons[idx] ?? false;
      if (name === 'fire') {
        out.fire = pressed;
      } else if (name === 'turbo') {
        if (pressed) input.turbo = true;
      } else if (name === 'missile') {
        if (pressed && !was) out.missile = true;
      } else if (pressed && !was) {
        const action = BUTTON_ACTION[name];
        if (action) out.actions.push(action);
      }
    }
    this.prevButtons = gp.buttons.map((b) => b.pressed);
    return out;
  }
}

export function describeAxis(name: HotasAxis): string {
  const b = hotas.axes[name];
  return b ? `AXIS ${b.index}${b.invert ? ' (inv)' : ''}` : '—';
}

export function describeButton(name: HotasButton): string {
  const b = hotas.buttons[name];
  return b !== undefined ? `BTN ${b}` : '—';
}

export function bindAxis(name: HotasAxis, index: number, invert: boolean): void {
  hotas.axes[name] = { index, invert };
  saveHotas();
}

export function bindButton(name: HotasButton, index: number): void {
  hotas.buttons[name] = index;
  saveHotas();
}

export function clearHotasBind(kind: 'axis' | 'button', name: string): void {
  if (kind === 'axis') delete hotas.axes[name as HotasAxis];
  else delete hotas.buttons[name as HotasButton];
  saveHotas();
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
