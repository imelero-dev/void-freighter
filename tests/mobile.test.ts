// Mobile support must never leak into headless / desktop contexts: the
// detection and haptics helpers are imported by input/settings/hud, so they
// have to be safely evaluable with no DOM at all.

import { describe, expect, it } from 'vitest';
import { buzz, HAPTIC } from '../src/game/haptics';
import { isMobile } from '../src/game/mobile';
import { settings } from '../src/ui/settings';

describe('mobile support (headless safety + defaults)', () => {
  it('isMobile() is false without a DOM', () => {
    expect(isMobile()).toBe(false);
  });

  it('settings carry the touch defaults on non-touch devices', () => {
    expect(settings.touchSens).toBe(1.5);
    expect(settings.mobileControls).toBe(false);
  });

  it('buzz() is a silent no-op off-device', () => {
    expect(() => buzz(HAPTIC.hullHit)).not.toThrow();
    expect(() => buzz(HAPTIC.lockWarning)).not.toThrow();
  });
});
