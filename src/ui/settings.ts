// Player settings: persisted to localStorage, applied live.

import { isMobile } from '../game/mobile';

export interface GameSettings {
  sensitivity: number;  // mouse multiplier, 0.4–2.5
  touchSens: number;    // touch-stick multiplier, 0.5–3.0
  invertY: boolean;
  volume: number;       // master, 0–1
  aimAssist: boolean;   // gentle pull toward the locked target
  mobileControls: boolean; // touch overlay (defaults on for touch devices)
}

const KEY = 'vf_settings_v1';

const DEFAULTS: GameSettings = {
  sensitivity: 1, touchSens: 1.5, invertY: false, volume: 1, aimAssist: true,
  mobileControls: false,
};

function load(): GameSettings {
  const defaults: GameSettings = { ...DEFAULTS, mobileControls: isMobile() };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      sensitivity: clampNum(parsed.sensitivity, 0.4, 2.5, 1),
      touchSens: clampNum(parsed.touchSens, 0.5, 3, 1.5),
      invertY: !!parsed.invertY,
      volume: clampNum(parsed.volume, 0, 1, 1),
      aimAssist: parsed.aimAssist !== false,
      mobileControls: typeof parsed.mobileControls === 'boolean' ? parsed.mobileControls : defaults.mobileControls,
    };
  } catch {
    return defaults;
  }
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const settings: GameSettings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* private mode */ }
}
