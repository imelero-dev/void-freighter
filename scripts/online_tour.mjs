// Online E2E: boots the real game server (in-memory DB), connects two real
// browser clients, verifies they see each other in space + shared economy.
//
//   npm run build && npm run build:server && node scripts/online_tour.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'screenshots');
const PORT = 4791;

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

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function newClient(browser, name) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error(`[${name}] pageerror:`, err.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await sleep(500);
  // register through the real menu UI
  await page.evaluate((user) => {
    const inputs = [...document.querySelectorAll('.vf-input')];
    inputs[1].value = user;          // callsign
    inputs[2].value = 'secret1';     // password
  }, name);
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    buttons.find((b) => b.textContent === 'REGISTER')?.click();
  });
  await page.waitForFunction(() => window.VF?.world?.connected === true, { timeout: 10_000 });
  return page;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = spawn('node', [join(ROOT, 'dist-server', 'server.cjs')], {
    env: { ...process.env, PORT: String(PORT), ALLOW_DEV_COMMANDS: '1', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await sleep(1500);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio'],
    defaultViewport: { width: 1280, height: 800 },
  });

  let failed = false;
  try {
    console.log('connecting client A…');
    const a = await newClient(browser, 'tour_alice');
    console.log('connecting client B…');
    const b = await newClient(browser, 'tour_bob');

    // status should report 2 online
    const status = await (await fetch(`http://localhost:${PORT}/api/status`)).json();
    console.log('status:', JSON.stringify(status));
    if (status.players_online !== 2) throw new Error(`expected 2 online, got ${status.players_online}`);

    // both undock
    for (const page of [a, b]) {
      await page.keyboard.press('Escape'); // close market window
      await sleep(200);
      await page.keyboard.press('Space');
      await sleep(500);
    }
    await sleep(2500);

    // A should see B as a player entity
    const seen = await a.evaluate(() => {
      const w = window.VF.world;
      return [...w.entities.values()].filter((e) => e.isPlayer && e.id !== w.playerId).map((e) => e.name);
    });
    console.log('A sees players:', seen);
    if (!seen.includes('tour_bob')) throw new Error('A does not see B in space');

    // shared market data: B asks for known-station markets (async round trip)
    let stock = -1;
    for (let i = 0; i < 10 && stock < 0; i++) {
      stock = await b.evaluate(() => {
        const w = window.VF.world;
        return w.market('morrow_granary')?.find((x) => x.good === 'food')?.stock ?? -1;
      });
      if (stock < 0) await sleep(700);
    }
    console.log('B market stock(food) @ morrow:', stock);
    if (stock < 0) throw new Error('B has no market data for its home station');

    // chat from A reaches B (both near the station => local channel)
    const stateA = await a.evaluate(() => ({ docked: window.VF.world.player?.dockedAt, pos: window.VF.world.player?.pos }));
    const stateB = await b.evaluate(() => ({ docked: window.VF.world.player?.dockedAt, pos: window.VF.world.player?.pos }));
    console.log('A state:', JSON.stringify(stateA), 'B state:', JSON.stringify(stateB));
    await a.evaluate(() => window.VF.world.chat('void check 1-2'));
    let heard = false;
    for (let i = 0; i < 8 && !heard; i++) {
      await sleep(500);
      heard = await b.evaluate(() => document.body.innerText.includes('void check 1-2'));
    }
    if (!heard) throw new Error('chat did not reach client B');
    console.log('chat ✓');

    await a.screenshot({ path: join(SHOTS, '09_online_two_clients.png') });
    console.log('📸 09_online_two_clients');
    console.log('\n✅ online tour passed');
  } catch (err) {
    failed = true;
    console.error('\n❌ online tour failed:', err.message);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(500);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
