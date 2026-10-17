// Smoke test for the itch.io package: unzips it, serves it from a sub-path
// inside an iframe (the way itch.io embeds HTML5 games), launches a solo game
// in headless Chrome and fails on any console error, page error, failed
// request or request outside the game's own folder (e.g. /api, /ws).
//
//   npm run build:itch && npm run verify:itch [-- path/to/zip]

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import puppeteer from 'puppeteer-core';
import { ROOT, findChrome } from './lib/browser.mjs';
import { readZip } from './lib/zip.mjs';
import { ITCH_ZIP } from './build_itch.mjs';

const PORT = 4797;
const GAME_PATH = '/html/1234567/'; // itch.io-style sub-path
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function unzipTo(zipPath, dir) {
  for (const [name, data] of readZip(readFileSync(zipPath))) {
    const file = join(dir, name);
    if (relative(dir, file).startsWith('..')) throw new Error(`zip entry escapes root: ${name}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  if (!existsSync(join(dir, 'index.html'))) throw new Error('index.html is not at the zip root');
}

async function main() {
  const zipPath = process.argv[2] ?? ITCH_ZIP;
  if (!existsSync(zipPath)) throw new Error(`${zipPath} not found — run npm run build:itch first`);
  const dir = mkdtempSync(join(tmpdir(), 'vf-itch-'));
  unzipTo(zipPath, dir);

  const outside = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><body style="margin:0;background:#222">
        <iframe id="game" src="${GAME_PATH}index.html" width="1280" height="720"
          allow="autoplay; fullscreen *; gamepad" allowfullscreen style="border:0"></iframe></body>`);
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    const file = path.startsWith(GAME_PATH) ? join(dir, path.slice(GAME_PATH.length)) : null;
    if (!file || relative(dir, file).startsWith('..') || !existsSync(file)) {
      outside.push(path);
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(PORT, ok));

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio'],
    defaultViewport: { width: 1300, height: 740 },
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
    const frame = await (await page.$('#game')).contentFrame();
    await frame.waitForSelector('.vf-menu button');
    const menu = await frame.evaluate(() => ({
      hasOnline: /ONLINE|LOG IN|REGISTER/.test(document.querySelector('.vf-menu')?.textContent ?? ''),
    }));
    if (menu.hasOnline) errors.push('menu still shows the ONLINE panel');

    await frame.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      buttons.find((b) => /LAUNCH|CONTINUE/.test(b.textContent ?? ''))?.click();
    });
    await sleep(5000);
    const state = await frame.evaluate(() => ({
      menuHidden: getComputedStyle(document.querySelector('.vf-menu')).display === 'none',
    }));
    if (!state.menuHidden) errors.push('LAUNCH did not start the game');
    mkdirSync(join(ROOT, 'release'), { recursive: true });
    const shot = join(ROOT, 'release', 'itch-verify.png');
    await page.screenshot({ path: shot });

    if (outside.length) errors.push(`requests outside the game folder: ${[...new Set(outside)].join(', ')}`);
    if (errors.length) {
      console.error(`✕ itch.io package failed:\n  - ${errors.join('\n  - ')}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ ${relative(ROOT, zipPath)} launches offline in an iframe sub-path, 0 console errors`);
      console.log(`  screenshot: ${relative(ROOT, shot)}`);
    }
  } finally {
    await browser.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
