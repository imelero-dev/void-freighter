// Player settings: persisted to localStorage, applied live.

export interface GameSettings {
  sensitivity: number;  // mouse multiplier, 0.4–2.5
  invertY: boolean;
  volume: number;       // master, 0–1
  aimAssist: boolean;   // gentle pull toward the locked target
  shadows: boolean;     // real-time shadow maps (costs GPU time)
  showFps: boolean;     // small fps/frametime readout on the HUD
}

const KEY = 'vf_settings_v1';

const DEFAULTS: GameSettings = {
  sensitivity: 1, invertY: false, volume: 1, aimAssist: true,
  shadows: true, showFps: false,
};

function load(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      sensitivity: clampNum(parsed.sensitivity, 0.4, 2.5, 1),
      invertY: !!parsed.invertY,
      volume: clampNum(parsed.volume, 0, 1, 1),
      aimAssist: parsed.aimAssist !== false,
      shadows: parsed.shadows !== false,
      showFps: !!parsed.showFps,
    };
  } catch {
    return { ...DEFAULTS };
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
