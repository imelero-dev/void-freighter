// Full gameplay journey in a real browser: accept a transport contract,
// undock, autopilot-cruise to the destination station, dock, get paid.
// This exercises contracts, GPS, cruise, mass-lock arrival and docking
// exactly the way a player does (inputs only — no teleports).
//
//   npm run build && node scripts/playtest_journey.mjs

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer-core';

const DIST = resolve(import.meta.dirname, '..', 'dist');
const SHOTS = resolve(import.meta.dirname, '..', 'screenshots');
const PORT = 4793;

function findChrome() {
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
  throw new Error('no Chromium found — set CHROME_BIN');
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await sleep(600);

  // fresh offline game
  await page.evaluate(() => {
    localStorage.removeItem('void_freighter_save_v1');
    const buttons = [...document.querySelectorAll('button')];
    (buttons.find((b) => /LAUNCH|NEW GAME|CONTINUE/.test(b.textContent ?? ''))).click();
  });
  await page.waitForFunction(() => !!window.VF?.world?.player, { timeout: 10_000 });
  await sleep(1000);

  // accept the nearest-destination transport contract that fits the hold
  const contract = await page.evaluate(() => {
    const w = window.VF.world;
    const here = w.dockedStation;
    const board = w.board(here.id);
    // rookie-accessible: small, no rep gate (reward < 1800), legal cargo
    const fits = board.filter((c) => (c.type === 'transport' || c.type === 'urgent')
      && c.qty <= 16 && c.reward < 1800);
    if (fits.length === 0) return null;
    const dist = (id) => {
      const st = w.system.stations.find((s) => s.id === id);
      return Math.hypot(st.pos.x - here.pos.x, st.pos.y - here.pos.y, st.pos.z - here.pos.z);
    };
    fits.sort((a, b) => dist(a.dest) - dist(b.dest));
    const c = fits[0];
    w.acceptContract(c.id);
    const st = w.system.stations.find((s) => s.id === c.dest);
    w.setDestination({ kind: 'station', id: st.id, name: st.name, pos: { ...st.pos } });
    return { id: c.id, dest: c.dest, reward: c.reward, desc: c.desc, distMm: (dist(c.dest) / 1e6).toFixed(1) };
  });
  if (!contract) throw new Error('no acceptable contract on the home board');
  console.log(`contract: ${contract.desc} (+${contract.reward} cr, ${contract.distMm} Mm)`);
  const accepted = await page.evaluate(() => window.VF.world.profile.contracts.length);
  if (accepted !== 1) throw new Error('contract was not accepted');

  // undock (Space) — close windows first
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.keyboard.press('Space');
  await sleep(1500);

  // autopilot: steer toward destination, engage cruise, let arrival drop us out
  console.log('autopilot engaged…');
  const t0 = Date.now();
  let lastLog = 0;
  let arrived = false;
  while (Date.now() - t0 < 420_000) {
    const state = await page.evaluate((destId) => {
      const w = window.VF.world;
      const V = window.VF.vec;
      const e = w.player;
      const st = w.system.stations.find((s) => s.id === destId);
      const dest = w.destination ?? { pos: st.pos, name: st.name };
      if (!e || !dest) return null;
      const to = V.vnorm(V.vsub(dest.pos, e.pos));
      // direction in ship-local frame (conjugate rotate)
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
      const d = Math.hypot(dest.pos.x - e.pos.x, dest.pos.y - e.pos.y, dest.pos.z - e.pos.z);
      if (aligned && e.cruise === 'off' && d > 60_000) w.toggleCruise();
      return { d, cruise: e.cruise, speed: Math.hypot(e.vel.x, e.vel.y, e.vel.z), fuel: w.profile.fuel, docked: e.dockedAt };
    }, contract.dest);
    if (!state) throw new Error('lost world state');
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      console.log(`  d=${(state.d / 1e6).toFixed(2)} Mm  v=${Math.round(state.speed)} m/s  cruise=${state.cruise}  fuel=${state.fuel.toFixed(0)}`);
    }
    if (state.d < 35_000) {
      arrived = true;
      break;
    }
    await sleep(400);
  }
  if (!arrived) throw new Error('autopilot never arrived at the destination');
  console.log('arrived — final approach');
  await page.screenshot({ path: join(SHOTS, '10_journey_arrival.png') });

  // creep to dock range and request docking
  const approach = await page.evaluate(async (destId) => {
    const w = window.VF.world;
    const V = window.VF.vec;
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const st = w.system.stations.find((s) => s.id === destId);
    const telemetry = [];
    for (let i = 0; i < 1500; i++) {
      const e = w.player;
      if (i % 20 === 0) {
        telemetry.push({ i, d: Math.round(V.vdist(e.pos, st.pos)), v: Math.round(V.vlen(e.vel)), cr: e.cruise });
      }
      if (e.dockedAt) return { docked: e.dockedAt, telemetry };
      const to = V.vsub(st.pos, e.pos);
      const d = V.vlen(to);
      const dir = V.vnorm(to);
      const qc = { x: -e.orient.x, y: -e.orient.y, z: -e.orient.z, w: e.orient.w };
      const local = V.qrot(qc, dir);
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      const bot = {
        thrustForward: 0, thrustRight: 0, thrustUp: 0, roll: 0, brake: false,
        yaw: clamp(Math.atan2(-local.x, -local.z) * 1.6),
        pitch: clamp(Math.atan2(local.y, -local.z) * 1.6),
      };
      if (d > st.dockRadius * 0.6) {
        bot.thrustForward = Math.min(1, (d - st.dockRadius * 0.5) / 2000 + 0.15);
        // low-gear cruise hops close the last tens of km (mass cap keeps it slow)
        const aligned = Math.abs(bot.yaw) < 0.1 && Math.abs(bot.pitch) < 0.1;
        if (d > 9000 && aligned && e.cruise === 'off') w.toggleCruise();
      } else {
        bot.thrustForward = 0;
        bot.brake = true;
        w.requestDock();
      }
      window.VF.botInput = bot;
      await sleep(100);
    }
    return { docked: null, telemetry };
  }, contract.dest);
  await page.evaluate(() => { delete window.VF.botInput; });
  const docked = approach.docked;
  if (docked !== contract.dest) {
    console.error('approach telemetry:', JSON.stringify(approach.telemetry.slice(-25)));
    throw new Error(`expected to dock at ${contract.dest}, got ${docked}`);
  }
  await sleep(1000);
  const result = await page.evaluate(() => ({
    contracts: window.VF.world.profile.contracts.length,
    credits: window.VF.world.profile.credits,
    rep: window.VF.world.profile.reputation,
  }));
  console.log(`docked at ${docked} — contracts left: ${result.contracts}, credits: ${result.credits}`);
  await page.screenshot({ path: join(SHOTS, '11_journey_delivered.png') });
  if (result.contracts !== 0) throw new Error('contract did not auto-complete on docking');
  if (result.credits <= 2000) throw new Error('no payout received');

  await browser.close();
  server.close();
  const fatal = errors.filter((e) => !e.includes('WebGL'));
  if (fatal.length) {
    console.error('❌ page errors:', fatal.slice(0, 5));
    process.exit(1);
  }
  console.log('\n✅ playtest journey passed — contract hauled, paid in full');
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
