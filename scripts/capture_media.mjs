// README media: flies a real contract run in headless Chromium and records
// undock -> turn to destination -> cruise spool-up as screenshots/cruise.gif,
// plus a still once the cruise drive is up to speed.
// Inputs only, like playtest_journey.mjs — nothing is staged or teleported.
//
//   npm run media    (= npm run build:e2e && node scripts/capture_media.mjs)
//
// Needs ffmpeg on PATH for the GIF encode (denoised: the film-grain post
// effect otherwise doubles the file size).

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import { E2E_DIST as DIST, ROOT, findChrome } from './lib/browser.mjs';

const SHOTS = join(ROOT, 'screenshots');
const PORT = 4795;
const MAX_FRAMES = 600;
const FPS = 8; // capture rate; the GIF is a time-lapse of at most GIF_FRAMES
const GIF_FRAMES = 60;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// one autopilot tick: point the nose at the destination, full throttle,
// engage cruise once aligned (same steering law as playtest_journey.mjs)
function steer() {
  const w = window.VF.world;
  const V = window.VF.vec;
  const e = w.player;
  const dest = w.destination;
  const to = V.vnorm(V.vsub(dest.pos, e.pos));
  const qc = { x: -e.orient.x, y: -e.orient.y, z: -e.orient.z, w: e.orient.w };
  const local = V.qrot(qc, to);
  const yawErr = Math.atan2(-local.x, -local.z);
  const pitchErr = Math.atan2(local.y, -local.z);
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  window.VF.botInput = {
    thrustForward: 1, thrustRight: 0, thrustUp: 0,
    yaw: clamp(yawErr * 1.6), pitch: clamp(pitchErr * 1.6), roll: 0, brake: false,
  };
  const aligned = Math.abs(yawErr) < 0.06 && Math.abs(pitchErr) < 0.06;
  const d = V.vdist(dest.pos, e.pos);
  // retry at most every 3 s: each refused attempt (mass lock) logs a HUD line
  const now = performance.now();
  if (aligned && e.cruise === 'off' && d > 60_000 && now - (window.__vfCruiseTry ?? -1e9) > 3000) {
    window.__vfCruiseTry = now;
    w.toggleCruise();
  }
  return { d, cruise: e.cruise, speed: V.vlen(e.vel) };
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = createServer((req, res) => {
    let path = (req.url ?? '/').split('?')[0];
    if (path === '/') path = '/index.html';
    const file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file)) {
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
    defaultViewport: { width: 1280, height: 800 },
  });
  const frames = mkdtempSync(join(tmpdir(), 'vf-media-'));
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      localStorage.removeItem('void_freighter_save_v1');
      [...document.querySelectorAll('button')].find((b) => /LAUNCH|NEW GAME|CONTINUE/.test(b.textContent ?? '')).click();
    });
    await page.waitForFunction(() => !!window.VF?.world?.player, { timeout: 10_000 });
    await sleep(1000);

    // the farthest rookie contract gives the longest cruise leg
    const contract = await page.evaluate(() => {
      const w = window.VF.world;
      const here = w.dockedStation;
      const dist = (id) => {
        const st = w.system.stations.find((s) => s.id === id);
        return Math.hypot(st.pos.x - here.pos.x, st.pos.y - here.pos.y, st.pos.z - here.pos.z);
      };
      const fits = w.board(here.id)
        .filter((c) => (c.type === 'transport' || c.type === 'urgent') && c.qty <= 16 && c.reward < 1800)
        .sort((a, b) => dist(b.dest) - dist(a.dest));
      const c = fits[0];
      if (!c) return null;
      w.acceptContract(c.id);
      const st = w.system.stations.find((s) => s.id === c.dest);
      w.setDestination({ kind: 'station', id: st.id, name: st.name, pos: { ...st.pos } });
      return c.desc;
    });
    if (!contract) throw new Error('no acceptable contract on the home board');
    console.log(`contract: ${contract}`);

    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Space');
    await sleep(800);

    // the autopilot runs in the page so steering does not depend on how fast
    // the (slow, software-rendered) screenshots come back
    await page.evaluate(`window.__vfSteer = setInterval(${steer.toString()}, 50)`);
    const status = () => page.evaluate(() => {
      const e = window.VF.world.player;
      return { cruise: e.cruise, speed: window.VF.vec.vlen(e.vel) };
    });

    // record from the undock until the cruise drive is well spooled up
    let n = 0;
    let state;
    const deadline = Date.now() + 240_000;
    while (n < MAX_FRAMES && Date.now() < deadline) {
      const t = Date.now();
      await page.screenshot({ path: join(frames, `f${String(n++).padStart(3, '0')}.png`) });
      state = await status();
      if (state.cruise !== 'off' && state.speed > 60_000) break;
      if (n % 40 === 0) console.log(`  frame ${n}: ${Math.round(state.speed)} m/s, cruise ${state.cruise}`);
      await sleep(Math.max(0, 1000 / FPS - (Date.now() - t)));
    }
    if (state.cruise === 'off') throw new Error('cruise never engaged while recording');
    console.log(`recorded ${n} frames, cruising at ${Math.round(state.speed)} m/s`);
    await page.screenshot({ path: join(SHOTS, '14_cruise.png') });
    await page.evaluate(() => {
      clearInterval(window.__vfSteer);
      delete window.VF.botInput;
    });

    const gif = join(SHOTS, 'cruise.gif');
    const step = Math.ceil(n / GIF_FRAMES);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%03d.png'),
      '-vf', `select='not(mod(n\\,${step}))',setpts=N/${FPS}/TB,hqdn3d=8:6:12:12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      '-r', String(FPS), '-loop', '0', gif,
    ]);
    console.log(`📸 14_cruise.png  🎞  cruise.gif (${(statSync(gif).size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    await browser.close();
    server.close();
    rmSync(frames, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
