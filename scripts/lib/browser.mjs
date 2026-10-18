// Shared helpers for the headless-browser scripts (tours, playtest, media).

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const ROOT = resolve(import.meta.dirname, '..', '..');

// The tours drive the game through window.VF, which only the dev-tools build
// exposes (`npm run build:e2e` -> dist-e2e/). Override with VF_DIST.
export const E2E_DIST = resolve(process.env.VF_DIST ?? join(ROOT, 'dist-e2e'));

// Browser binary resolution: CHROME_BIN, then Playwright cache, then system.
export function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const pwRoot = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pwRoot)) {
    for (const dir of readdirSync(pwRoot)) {
      for (const bin of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
        const p = join(pwRoot, dir, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error('no Chromium found — set CHROME_BIN');
}

// The menu probes /api/status to detect a game server; on a static host that
// 404 is expected and must not count as a page error.
export function isExpectedConsoleError(msg) {
  return (msg.location()?.url ?? '').includes('/api/status');
}
