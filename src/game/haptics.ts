// Haptic feedback for phones (navigator.vibrate — Android Chrome; iOS Safari
// has no vibration API, so everything degrades to a silent no-op).

import { isMobile } from './touch';

export const HAPTIC = {
  hullHit: [40],
  lockWarning: [30, 60, 30],
  docked: [10, 30, 80],
  overheat: [20, 20, 20, 20, 20],
} as const;

export function buzz(pattern: readonly number[]): void {
  if (!isMobile()) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern as number[]);
  } catch { /* blocked by permissions policy */ }
}
