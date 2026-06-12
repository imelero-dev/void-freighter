// Player settings: persisted to localStorage, applied live.

import { isMobile } from '../game/touch';

export interface GameSettings {
  sensitivity: number;  // mouse multiplier, 0.4–2.5
  invertY: boolean;
  volume: number;       // master, 0–1
  aimAssist: boolean;   // gentle pull toward the locked target
  shadows: boolean;     // real-time shadow maps (costs GPU time)
  showFps: boolean;     // small fps/frametime readout on the HUD
  mobileControls: boolean; // touch overlay (defaults on for touch devices)
}

const KEY = 'vf_settings_v1';

const DEFAULTS: GameSettings = {
  sensitivity: 1, invertY: false, volume: 1, aimAssist: true,
  shadows: true, showFps: false, mobileControls: false,
};

function load(): GameSettings {
  // mobile GPUs choke on shadow maps: default them off there unless the
  // user has explicitly saved a preference
  const mobile = isMobile();
  const defaults: GameSettings = { ...DEFAULTS, mobileControls: mobile, shadows: !mobile };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      sensitivity: clampNum(parsed.sensitivity, 0.4, 2.5, 1),
      invertY: !!parsed.invertY,
      volume: clampNum(parsed.volume, 0, 1, 1),
      aimAssist: parsed.aimAssist !== false,
      shadows: typeof parsed.shadows === 'boolean' ? parsed.shadows : defaults.shadows,
      showFps: !!parsed.showFps,
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
