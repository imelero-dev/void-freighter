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

  // turn around to face the station (checks sun-side lighting)
  await page.evaluate(() => {
    window.VF.botInput = { thrustForward: 0, thrustRight: 0, thrustUp: 0, pitch: 0, yaw: 1, roll: 0, brake: false };
  });
  await sleep(1900);
  await page.evaluate(() => {
    delete window.VF.botInput;
  });
  await sleep(600);
  await shot('03b_station_exterior');

  // throttle up and fly a bit
  await page.keyboard.down('KeyW');
  await sleep(2500);
  await page.keyboard.up('KeyW');
  await shot('04_flying');

  // cruise toward somewhere ("hypervelocity" is CapsLock now)
  await page.keyboard.press('CapsLock');
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
  await page.keyboard.press('KeyV');

  // teleport into a belt field (offline world exposes the sim) for mining vista
  await page.evaluate(() => {
    const w = window.VF.world;
    const field = w.system.belts[0].fields[0];
    const e = w.sim.entities.get(w.playerId);
    e.cruise = 'off';
    e.pos = { x: field.pos.x + 2000, y: field.pos.y + 300, z: field.pos.z };
    e.prevPos = { ...e.pos };
    e.vel = { x: 0, y: 0, z: 0 };
  });
  await sleep(2500);
  await shot('12_asteroid_field');

  // mining: fit a drill, park next to the nearest rock, fire the beam.
  // 12b must show the beam in COCKPIT view (it used to be invisible there).
  await page.evaluate(() => {
    const w = window.VF.world;
    const V = window.VF.vec;
    const sim = w.sim;
    const e = sim.entities.get(w.playerId);
    const meta = sim.meta(w.playerId);
    meta.profile.modules.drill = 2;
    sim.recomputeStats(w.playerId);
    let rock = null;
    let bestD = Infinity;
    for (const t of sim.entities.values()) {
      if (t.kind !== 'asteroid') continue;
      const d = V.vdist(t.pos, e.pos);
      if (d < bestD) {
        bestD = d;
        rock = t;
      }
    }
    e.pos = V.vadd(rock.pos, V.vscale(V.vnorm(V.vsub(e.pos, rock.pos)), rock.radius + 170));
    e.prevPos = { ...e.pos };
    e.vel = { x: 0, y: 0, z: 0 };
    e.orient = V.qLookAt(V.vnorm(V.vsub(rock.pos, e.pos)));
    e.prevOrient = { ...e.orient };
    w.setDrill(true);
    w.setMiningBeam(true);
  });
  await sleep(1500);
  await shot('12b_mining_beam_cockpit');
  await page.keyboard.press('KeyV');
  await sleep(800);
  await shot('12c_mining_beam_chase');
  await page.keyboard.press('KeyV');
  await sleep(300);

  // graphics settings applied hot: fps overlay + shadows off/on
  const setCheckbox = (label, on) => page.evaluate(({ label, on }) => {
    for (const row of document.querySelectorAll('.vf-set-row')) {
      const span = row.querySelector('.vf-set-label');
      const input = row.querySelector('input[type="checkbox"]');
      if (span && input && span.textContent === label && input.checked !== on) {
        input.checked = on;
        input.dispatchEvent(new Event('change'));
      }
    }
  }, { label, on });
  await setCheckbox('Show FPS', true);
  await sleep(900);
  await shot('15_fps_shadows_on');
  await setCheckbox('Shadows', false);
  await sleep(700);
  await shot('15b_shadows_off');
  await setCheckbox('Shadows', true);
  await setCheckbox('Show FPS', false);
  await page.evaluate(() => {
    window.VF.world.setMiningBeam(false);
    window.VF.world.setDrill(false);
  });
  await sleep(300);

  // ambient traffic showcase: a bulk carrier sliding past + patrol + trader
  await page.evaluate(() => {
    const w = window.VF.world;
    const V = window.VF.vec;
    const sim = w.sim;
    const e = w.player;
    const fwd = V.qForward(e.orient);
    const mk = (npc, hullId, name, off, hull) => {
      const n = sim.spawnShipEntity();
      n.npc = npc;
      n.hullId = hullId;
      n.factionId = 'meridian';
      n.name = name;
      n.maxHull = hull;
      n.hull = hull;
      n.maxShield = 200;
      n.shield = 200;
      n.pos = V.vadd(e.pos, off);
      n.prevPos = { ...n.pos };
      n.spawnPos = { ...n.pos };
      return n;
    };
    const sf = mk('superfreighter', 'freighter', 'BHC "Iron Promise" (bulk carrier)', V.vadd(V.vscale(fwd, 900), { x: 250, y: 80, z: 0 }), 4000);
    sf.orient = e.orient;
    sf.vel = V.vscale(fwd, 30);
    mk('patrol', 'interceptor', 'Meridian Charter Patrol', V.vadd(V.vscale(fwd, 500), { x: -160, y: -30, z: 0 }), 220);
    mk('merchant', 'prospector', '"Lucky Ledger" (trader)', V.vadd(V.vscale(fwd, 420), { x: 60, y: 40, z: 60 }), 260);
  });
  await sleep(1200);
  await shot('14_traffic');

  // dogfight: spawn a pirate dead ahead and exchange fire
  await page.evaluate(() => {
    const w = window.VF.world;
    const V = window.VF.vec;
    const e = w.sim.entities.get(w.playerId);
    const fwd = V.qForward(e.orient);
    const pirate = w.sim.spawnPirate('fighter', V.vadd(e.pos, V.vscale(fwd, 450)));
    w.setTarget(pirate.id);
    w.setFiring(true);
  });
  await sleep(1800);
  await shot('13_dogfight');
  await page.evaluate(() => window.VF.world.setFiring(false));

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
