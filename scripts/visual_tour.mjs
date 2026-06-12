// E2E visual tour: serves the built client, drives it in headless Chromium,
// captures screenshots and fails on any page error.
//
//   npm run build && node scripts/visual_tour.mjs
//
// Browser binary resolution: PLAYWRIGHT/PUPPETEER caches or CHROME_BIN.

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer-core';

const DIST = resolve(import.meta.dirname, '..', 'dist');
const SHOTS = resolve(import.meta.dirname, '..', 'screenshots');
const PORT = 4789;

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

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader', '--window-size=1280,800', '--mute-audio',
    ],
    defaultViewport: { width: 1280, height: 800 },
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
  await shot('01_menu');

  // launch offline game
  await page.evaluate(() => {
    const input = document.querySelector('.vf-input');
    if (input) input.value = 'TourBot';
  });
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const launch = buttons.find((b) => /LAUNCH|CONTINUE/.test(b.textContent ?? ''));
    launch?.click();
  });
  await sleep(3500);
  await shot('02_docked_station');

  // close windows and undock
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.keyboard.press('Space');
  await sleep(2500);
  await shot('03_space_undocked');

  // throttle up and fly a bit
  await page.keyboard.down('KeyW');
  await sleep(2500);
  await page.keyboard.up('KeyW');
  await shot('04_flying');

  // cruise toward somewhere
  await page.keyboard.press('ShiftLeft');
  await sleep(4500);
  await shot('05_cruise');

  // system map
  await page.keyboard.press('KeyM');
  await sleep(600);
  await shot('06_map');
  await page.keyboard.press('Escape');

  // ship sheet
  await page.keyboard.press('KeyC');
  await sleep(500);
  await shot('07_ship');
  await page.keyboard.press('Escape');

  // chase camera
  await page.keyboard.press('KeyV');
  await sleep(400);
  await shot('08_chase_camera');

  await browser.close();
  server.close();

  const fatal = errors.filter((e) => !e.includes('WebGL') && !e.includes('GroupMarkerNotSet'));
  if (fatal.length > 0) {
    console.error(`\n❌ ${fatal.length} page error(s):`);
    for (const e of fatal.slice(0, 20)) console.error('  ' + e);
    process.exit(1);
  }
  console.log('\n✅ visual tour completed without page errors');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
