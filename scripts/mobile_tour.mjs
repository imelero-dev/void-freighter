// E2E mobile tour: serves the built client, drives it in headless Chromium
// with touch emulation (phone landscape) and asserts the touch controls
// overlay appears and actually drives the ship.
//
//   npm run build && node scripts/mobile_tour.mjs
//
// Browser binary resolution: PLAYWRIGHT/PUPPETEER caches or CHROME_BIN.

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer-core';

const DIST = resolve(import.meta.dirname, '..', 'dist');
const SHOTS = resolve(import.meta.dirname, '..', 'screenshots');
const PORT = 4791;

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [];
  const pwRoot = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pwRoot)) {
    for (const dir of readdirSync(pwRoot)) {
      for (const bin of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
        const p = join(pwRoot, dir, bin);
        if (existsSync(p)) candidates.push(p);
      }
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(p)) candidates.push(p);
  }
  if (candidates.length === 0) throw new Error('no Chromium found — set CHROME_BIN');
  return candidates[0];
}

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = createServer((req, res) => {
    let path = (req.url ?? '/').split('?')[0];
    if (path === '/') path = '/index.html';
    const file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, () => ok(server)));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`✓ ${msg}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader', '--mute-audio',
    ],
    // phone in landscape (the flight orientation)
    defaultViewport: { width: 812, height: 375, isMobile: true, hasTouch: true },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  const shot = async (name) => {
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    console.log(`📸 ${name}`);
  };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await sleep(800);
  await shot('m01_menu');

  const touchSetting = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.vf-set-label')].map((l) => l.textContent);
    return { controls: labels.includes('Touch controls'), sens: labels.includes('Touch sensitivity') };
  });
  assert(touchSetting.controls, 'menu shows the Touch controls checkbox');
  assert(touchSetting.sens, 'menu shows the Touch sensitivity slider');

  // launch offline game
  await page.evaluate(() => {
    const input = document.querySelector('.vf-input');
    if (input) input.value = 'TouchBot';
    const buttons = [...document.querySelectorAll('button')];
    const launch = buttons.find((b) => /LAUNCH|CONTINUE/.test(b.textContent ?? ''));
    launch?.click();
  });
  await sleep(3500);

  const overlay = await page.evaluate(() => {
    const root = document.getElementById('vf-touch');
    if (!root) return null;
    return { visible: root.style.display !== 'none', buttons: root.querySelectorAll('.vf-touch-btn').length };
  });
  assert(overlay, 'touch overlay exists in-game');
  assert(!overlay.visible, 'flight overlay hidden while docked (dockbar takes over)');
  assert(overlay.buttons >= 14, `overlay has all buttons (${overlay.buttons})`);
  await shot('m02_docked');

  const tapButton = async (label, selector = '#vf-touch .vf-touch-btn') => {
    const box = await page.evaluate(({ wanted, sel }) => {
      const btn = [...document.querySelectorAll(sel)].find((b) => b.textContent === wanted);
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      if (r.width === 0) return null; // hidden (popover closed)
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, { wanted: label, sel: selector });
    if (!box) throw new Error(`touch button ${label} not found or hidden`);
    await page.touchscreen.tap(box.x, box.y);
  };
  const popoverOpen = () => page.evaluate(() => !!document.querySelector('.vf-touch-popover.open'));

  await page.keyboard.press('Escape'); // close the market window first
  await sleep(300);
  // undock via the dockbar (the flight overlay only returns in open space)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.vf-dockbar button')]
      .find((x) => (x.textContent ?? '').startsWith('UNDOCK'));
    b?.click();
  });
  await sleep(2500);
  const overlayBack = await page.evaluate(() => document.getElementById('vf-touch').style.display !== 'none');
  assert(overlayBack, 'touch overlay appears after undock');
  await shot('m03_undocked');

  // collapsed SYS menu: opens a popover, closes after firing an action
  await tapButton('SYS ▾', '#vf-touch .vf-touch-menubtn');
  await sleep(250);
  assert(await popoverOpen(), 'SYS menu opens its popover');
  await shot('m03b_sys_popover');
  await tapButton('LIGHTS');
  await sleep(300);
  assert(!(await popoverOpen()), 'popover closes after tapping an action');

  // throttle slider: tap near the top -> high throttle
  const thr = await page.evaluate(() => {
    const r = document.querySelector('.vf-touch-throttle').getBoundingClientRect();
    return { x: r.x + r.width / 2, top: r.y + 6, bottom: r.y + r.height - 6 };
  });
  await page.touchscreen.tap(thr.x, thr.top);
  await sleep(400);
  let input = await page.evaluate(() => window.VF.world.input);
  assert(input.thrustForward > 0.9, `throttle slider sets thrust (${input.thrustForward.toFixed(2)})`);

  // look stick: drag inside the left zone -> pitch/yaw deflection
  await page.touchscreen.touchStart(160, 200);
  await page.touchscreen.touchMove(220, 150);
  await sleep(250);
  input = await page.evaluate(() => window.VF.world.input);
  assert(Math.abs(input.yaw) > 0.1, `look stick yaws (${input.yaw.toFixed(2)})`);
  assert(Math.abs(input.pitch) > 0.1, `look stick pitches (${input.pitch.toFixed(2)})`);
  await shot('m04_stick_drag');
  await page.touchscreen.touchEnd();
  // recenter lerp takes ~150ms of game time; poll (software rendering is slow)
  let recentered = false;
  for (let i = 0; i < 15 && !recentered; i++) {
    await sleep(150);
    input = await page.evaluate(() => window.VF.world.input);
    recentered = Math.abs(input.yaw) < 0.05 && Math.abs(input.pitch) < 0.05;
  }
  assert(recentered, `cursor recenters on release (${input.yaw.toFixed(2)})`);

  // hold FIRE: the sim must see the trigger down, then up
  const fire = await page.evaluate(() => {
    const r = document.querySelector('.vf-touch-fire').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.touchscreen.touchStart(fire.x, fire.y);
  await sleep(250);
  const firing = await page.evaluate(() => window.VF.world.player?.firing ?? null);
  await shot('m05_firing');
  await page.touchscreen.touchEnd();
  assert(firing === true, 'FIRE button hold fires the cannon');

  // ROLL hold: roll while pressed, strafe once dragged off the button
  const rollBox = await page.evaluate(() => {
    const r = document.querySelector('.vf-touch-roll-l').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.touchscreen.touchStart(rollBox.x, rollBox.y);
  await sleep(250);
  input = await page.evaluate(() => window.VF.world.input);
  assert(input.roll < -0.5, `ROLL hold rolls left (${input.roll.toFixed(2)})`);
  await page.touchscreen.touchMove(rollBox.x, rollBox.y - 60);
  await sleep(250);
  input = await page.evaluate(() => window.VF.world.input);
  assert(input.thrustUp > 0.3, `drag off ROLL strafes up (${input.thrustUp.toFixed(2)})`);
  assert(input.roll === 0, `strafe mode releases the roll (${input.roll.toFixed(2)})`);
  await shot('m05b_strafe');
  await page.touchscreen.touchEnd();
  await sleep(250);
  input = await page.evaluate(() => window.VF.world.input);
  assert(Math.abs(input.thrustUp) < 0.01, 'strafe clears on release');

  // system map: open via NAV popover, tap-select, drag-pan, pinch-zoom
  await tapButton('NAV ▾', '#vf-touch .vf-touch-menubtn');
  await sleep(250);
  await tapButton('MAP');
  await sleep(700);
  assert(!(await popoverOpen()), 'NAV popover closed after opening the map');
  const mapState = await page.evaluate(() => {
    const map = window.VF.app?.map;
    const canvas = document.querySelector('.vf-map-canvas');
    if (!map || !canvas) return null;
    const mk = (id, x, y) => new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
    const fire = (type, touches, changed) => canvas.dispatchEvent(new TouchEvent(type, {
      touches, changedTouches: changed ?? touches, bubbles: true, cancelable: true,
    }));
    const r = canvas.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;

    // tap-select the nearest station marker
    const st = window.VF.world.system.stations[0];
    const [sx, sy] = map.toScreen(st.pos.x, st.pos.z);
    const k = r.width / canvas.width;
    const tapX = r.x + sx * k, tapY = r.y + sy * k;
    fire('touchstart', [mk(1, tapX, tapY)]);
    fire('touchend', [], [mk(1, tapX, tapY)]);
    const picked = map.selected?.id === st.id ? st.id : (map.selected?.id ?? null);

    // one-finger pan
    const panBefore = { x: map.panX, y: map.panY };
    fire('touchstart', [mk(2, cx, cy)]);
    fire('touchmove', [mk(2, cx + 50, cy + 30)]);
    fire('touchend', [], [mk(2, cx + 50, cy + 30)]);
    const panned = map.panX !== panBefore.x || map.panY !== panBefore.y;

    // two-finger pinch out -> zoom in
    const zoomBefore = map.zoom;
    fire('touchstart', [mk(3, cx - 30, cy)]);
    fire('touchstart', [mk(3, cx - 30, cy), mk(4, cx + 30, cy)], [mk(4, cx + 30, cy)]);
    fire('touchmove', [mk(3, cx - 90, cy), mk(4, cx + 90, cy)]);
    fire('touchend', [], [mk(3, cx - 90, cy), mk(4, cx + 90, cy)]);
    return { expected: st.id, picked, panned, zoomBefore, zoomAfter: map.zoom };
  });
  assert(mapState, 'map window opened via NAV popover');
  assert(mapState.picked === mapState.expected, `tap selects a station (${mapState.picked})`);
  assert(mapState.panned, 'one-finger drag pans the map');
  assert(mapState.zoomAfter > mapState.zoomBefore * 1.5, `pinch-out zooms in (${mapState.zoomBefore} -> ${mapState.zoomAfter.toFixed(2)})`);
  await shot('m05c_map_touch');
  await page.keyboard.press('Escape'); // close the map
  await sleep(300);

  // cut throttle and fly straight for a clean final frame
  await page.touchscreen.tap(thr.x, thr.bottom);
  await sleep(600);
  await shot('m06_idle');

  await browser.close();
  server.close();

  if (errors.length > 0) {
    console.error('\n❌ page errors during mobile tour:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('\n✅ mobile tour completed without page errors');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
