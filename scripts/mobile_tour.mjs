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
    const labels = [...document.querySelectorAll('.vf-set-label')];
    return labels.some((l) => l.textContent === 'Touch controls');
  });
  assert(touchSetting, 'menu shows the Touch controls checkbox');

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
  assert(overlay.visible, 'touch overlay is visible');
  assert(overlay.buttons >= 14, `overlay has all buttons (${overlay.buttons})`);
  await shot('m02_docked');

  // undock via the touch DOCK button
  const tapButton = async (label) => {
    const box = await page.evaluate((wanted) => {
      const btn = [...document.querySelectorAll('#vf-touch .vf-touch-btn')]
        .find((b) => b.textContent === wanted);
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, label);
    if (!box) throw new Error(`touch button ${label} not found`);
    await page.touchscreen.tap(box.x, box.y);
  };
  await page.keyboard.press('Escape'); // close the market window first
  await sleep(300);
  await tapButton('DOCK');
  await sleep(2500);
  await shot('m03_undocked');

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
