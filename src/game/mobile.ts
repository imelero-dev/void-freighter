// Mobile detection, dependency-free so anything (settings, input, HUD, the
// touch overlay itself) can import it without creating module cycles.

// Touch screen and no fine pointer (mouse) -> phone/tablet. Guarded so it can
// be evaluated headless (vitest / node) where there is no DOM at all.
export function isMobile(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const touch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  if (!touch) return false;
  const fine = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
  return !fine;
}
