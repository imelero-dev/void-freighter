// Guided first haul in a real browser, driven like a new player who only
// follows the on-screen TUTORIAL hint: fresh localStorage -> LAUNCH -> close
// the market -> accept the ★ TUTORIAL haul -> undock -> set destination on
// the chart -> cruise -> dock and get paid. Logs every hint and the time to
// first delivery, then checks the tutorial never comes back.
//
//   npm run playtest:tutorial  (= npm run build:e2e && node scripts/playtest_tutorial.mjs)

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import { E2E_DIST as DIST, ROOT, findChrome } from './lib/browser.mjs';

const SHOTS = join(ROOT, 'screenshots');
const PORT = 4794;
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
  page.on('dialog', (d) => void d.accept()); // NEW GAME asks to confirm the wipe
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(500);

  const hasSkip = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'SKIP TUTORIAL' && b.offsetParent !== null));
  if (!hasSkip) throw new Error('fresh menu has no SKIP TUTORIAL button');

  const clickText = (re) => page.evaluate((src) => {
    const rx = new RegExp(src);
    const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent ?? '') && x.offsetParent !== null);
    if (!b) return false;
    b.click();
    return true;
  }, re.source);
  const hint = () => page.evaluate(() => {
    const h = window.VF?.app?.hud?.hint;
    return h ? `${h.label} ${h.text}` : null;
  });
  const step = () => page.evaluate(() => window.VF.app.tutorial?.step ?? 'done');
  const seen = [];
  const t0 = Date.now();
  const expectStep = async (want, shot) => {
    for (let i = 0; i < 40 && (await step()) !== want; i++) await sleep(100);
    const got = await step();
    if (got !== want) throw new Error(`expected tutorial step ${want}, got ${got}`);
    await sleep(250);
    const h = await hint();
    seen.push(h);
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${h}`);
    if (shot) await page.screenshot({ path: join(SHOTS, shot) });
  };

  if (!(await clickText(/^LAUNCH$/))) throw new Error('no LAUNCH button');
  await page.waitForFunction(() => !!window.VF?.app, { timeout: 10_000 });
  await sleep(800);
  // game-clock start: headless frames are slow under load, so wall time overstates
  const sim0 = await page.evaluate(() => window.VF.world.time);

  // 1. market — opened automatically on the first dock frame
  await expectStep('market', '20_tutorial_market.png');
  await page.keyboard.press('Escape'); // close it

  // 2. accept the ★ TUTORIAL haul from the board
  await expectStep('contract');
  await clickText(/^Contracts$/);
  await sleep(300);
  await page.screenshot({ path: join(SHOTS, '21_tutorial_contract.png') });
  const locked = await page.evaluate(() => document.querySelectorAll('.vf-contract .vf-locked').length);
  const accepted = await page.evaluate(() => {
    const card = document.querySelector('.vf-contract.vf-tutorial-focus');
    const b = card?.querySelector('button');
    if (!b) return false;
    b.click();
    return true;
  });
  if (!accepted) throw new Error('no ★ TUTORIAL contract on the board');
  console.log(`  (board: ${locked} other offers locked until the tutorial haul is taken)`);

  // 3. undock
  await expectStep('undock');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');

  // 4. destination via the chart: open with M, click the station, SET DESTINATION
  await expectStep('destination');
  await sleep(1200);
  await page.keyboard.press('KeyM');
  await sleep(300);
  const destName = await page.evaluate(() => {
    const w = window.VF.world;
    const c = w.profile.contracts[0];
    return w.system.stations.find((s) => s.id === c.dest).name;
  });
  await page.evaluate((name) => {
    const n = [...document.querySelectorAll('.vf-map-st-name')].find((x) => x.textContent === name);
    n.click();
  }, destName);
  await clickText(/^SET DESTINATION/);
  await sleep(200);
  await page.keyboard.press('Escape');

  // 5. throttle up and engage cruise once aligned with the marker
  await expectStep('cruise', '22_tutorial_cruise.png');
  let engaged = false;
  for (let i = 0; i < 300 && !engaged; i++) {
    const s = await page.evaluate(() => {
      const w = window.VF.world;
      const V = window.VF.vec;
      const e = w.player;
      const to = V.vnorm(V.vsub(w.destination.pos, e.pos));
      const qc = { x: -e.orient.x, y: -e.orient.y, z: -e.orient.z, w: e.orient.w };
      const local = V.qrot(qc, to);
      const yawErr = Math.atan2(-local.x, -local.z);
      const pitchErr = Math.atan2(local.y, -local.z);
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      window.VF.botInput = { thrustForward: 1, thrustRight: 0, thrustUp: 0, yaw: clamp(yawErr * 1.6), pitch: clamp(pitchErr * 1.6), roll: 0, brake: false };
      return { aligned: Math.abs(yawErr) < 0.06 && Math.abs(pitchErr) < 0.06, cruise: e.cruise, d: V.vdist(e.pos, w.destination.pos) };
    });
    if (s.cruise === 'cruise') engaged = true;
    else if (s.aligned && s.cruise === 'off' && i % 10 === 0) await page.keyboard.press('CapsLock');
    await sleep(200);
  }
  if (!engaged) throw new Error('cruise never engaged');

  // 6. hands off the stick: cruise autopilot homes in; then dock
  await expectStep('deliver', '23_tutorial_deliver.png');
  await page.evaluate(() => {
    window.VF.botInput = { thrustForward: 1, thrustRight: 0, thrustUp: 0, yaw: 0, pitch: 0, roll: 0, brake: false };
  });
  const tc = Date.now();
  let routeMm = null;
  while (Date.now() - tc < 240_000) {
    const d = await page.evaluate(() => window.VF.vec.vdist(window.VF.world.player.pos, window.VF.world.destination.pos));
    routeMm ??= d / 1e6;
    if (d < 35_000) break;
    await sleep(500);
  }
  const ta = Date.now();
  console.log(`  cruise leg: ${routeMm.toFixed(1)} Mm in ${((ta - tc) / 1000).toFixed(0)} s`);
  // final approach (same pilot logic as playtest_journey), Space to dock
  const docked = await page.evaluate(async () => {
    const w = window.VF.world;
    const V = window.VF.vec;
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const st = w.system.stations.find((s) => s.id === w.destination.id);
    for (let i = 0; i < 1500; i++) {
      const e = w.player;
      if (e.dockedAt) return e.dockedAt;
      const to = V.vsub(st.pos, e.pos);
      const d = V.vlen(to);
      const qc = { x: -e.orient.x, y: -e.orient.y, z: -e.orient.z, w: e.orient.w };
      const local = V.qrot(qc, V.vnorm(to));
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      const bot = {
        thrustForward: 0, thrustRight: 0, thrustUp: 0, roll: 0, brake: false,
        yaw: clamp(Math.atan2(-local.x, -local.z) * 1.6), pitch: clamp(Math.atan2(local.y, -local.z) * 1.6),
      };
      if (d > st.dockRadius * 0.6) {
        bot.thrustForward = Math.min(1, (d - st.dockRadius * 0.5) / 2000 + 0.15);
        const aligned = Math.abs(bot.yaw) < 0.1 && Math.abs(bot.pitch) < 0.1;
        if (d > 9000 && aligned && e.cruise === 'off') w.toggleCruise();
      } else {
        bot.brake = true;
        if (e.cruise !== 'off') w.toggleCruise();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
      }
      window.VF.botInput = bot;
      await sleep(100);
    }
    return null;
  });
  await page.evaluate(() => { delete window.VF.botInput; });
  if (!docked) throw new Error('never docked at the drop-off');
  console.log(`  final approach + docking: ${((Date.now() - ta) / 1000).toFixed(0)} s`);
  await sleep(800);
  const end = await page.evaluate(() => ({
    step: window.VF.app.tutorial?.step ?? 'done',
    hint: window.VF.app.hud.hint,
    credits: window.VF.world.profile.credits,
    done: window.VF.world.profile.stats.contractsDone,
    flag: localStorage.getItem('void_freighter_tutorial_done'),
    simTime: window.VF.world.time,
  }));
  await page.screenshot({ path: join(SHOTS, '24_tutorial_complete.png') });
  const secs = (Date.now() - t0) / 1000;
  if (end.step !== 'done' || end.hint !== null || end.done !== 1) throw new Error(`tutorial did not finish: ${JSON.stringify(end)}`);
  if (end.flag !== '1') throw new Error('tutorial-done flag not persisted');
  const simSecs = end.simTime - sim0;
  console.log(`  delivered: ${end.credits} cr, time to first delivery ${simSecs.toFixed(0)} s game time (${secs.toFixed(0)} s wall)`);

  // never again: reload -> CONTINUE, and NEW GAME, both without a hint
  for (const btn of [/^CONTINUE$/, /^NEW GAME$/]) {
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(400);
    if (!(await clickText(btn))) throw new Error(`no ${btn} button`);
    await page.waitForFunction(() => !!window.VF?.app, { timeout: 10_000 });
    await sleep(800);
    const again = await page.evaluate(() => ({ active: window.VF.app.tutorialActive, hint: window.VF.app.hud.hint }));
    if (again.active || again.hint) throw new Error(`tutorial reappeared after ${btn}`);
  }
  console.log('  tutorial stays gone after CONTINUE and NEW GAME');

  // skip path: a fresh browser profile (a reload would re-save on unload)
  await page.close();
  const ctx = await browser.createBrowserContext();
  const fresh = await ctx.newPage();
  fresh.on('pageerror', (err) => errors.push(err.message));
  await fresh.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await sleep(400);
  const skipClicked = await fresh.evaluate(() => {
    // the visible one next to LAUNCH (the pause-menu copy is hidden)
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'SKIP TUTORIAL' && x.offsetParent !== null);
    b?.click();
    return !!b;
  });
  if (!skipClicked) throw new Error('no SKIP TUTORIAL button');
  await fresh.waitForFunction(() => !!window.VF?.app, { timeout: 30_000 });
  await sleep(800);
  const skipped = await fresh.evaluate(() => ({
    active: window.VF.app.tutorialActive, hint: window.VF.app.hud.hint,
    flag: localStorage.getItem('void_freighter_tutorial_done'),
  }));
  if (skipped.active || skipped.hint || skipped.flag !== '1') throw new Error(`skip failed: ${JSON.stringify(skipped)}`);
  console.log('  SKIP TUTORIAL works');
  await ctx.close();

  await browser.close();
  server.close();
  const fatal = errors.filter((e) => !e.includes('WebGL'));
  if (fatal.length) {
    console.error('❌ page errors:', fatal.slice(0, 5));
    process.exit(1);
  }
  console.log(`\n✅ tutorial playtest passed — ${seen.length} hints, first haul in ${simSecs.toFixed(0)} s game time`);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
