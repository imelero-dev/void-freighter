// Focused visual inspection for the hangar / VTOL / atmosphere rework.
//   npm run build && CHROME_BIN=... node scripts/inspect.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const DIST = resolve(import.meta.dirname, '..', 'dist');
const SHOTS = resolve(import.meta.dirname, '..', 'screenshots', 'inspect');
const PORT = 4791;
const CHROME = process.env.CHROME_BIN || '/root/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

function serve() {
  const server = createServer((req, res) => {
    let path = (req.url ?? '/').split('?')[0];
    if (path === '/') path = '/index.html';
    const file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, () => ok(server)));
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1600,900', '--mute-audio'],
    defaultViewport: { width: 1600, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const shot = async (n) => { await page.screenshot({ path: join(SHOTS, `${n}.png`) }); console.log(`📸 ${n}`); };

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await sleep(800);
  await page.evaluate(() => { const i = document.querySelector('.vf-input'); if (i) i.value = 'Inspector'; });
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /LAUNCH|CONTINUE/.test(b.textContent ?? ''))?.click(); });
  await sleep(3000);
  await page.keyboard.press('Escape');
  await sleep(200);
  await page.keyboard.press('Space'); // undock
  await sleep(1500);

  // helper installed in page: frame + place
  await page.evaluate(() => {
    const V = window.VF.vec;
    window.IN = {
      frame(st) {
        const f = V.vnorm(st.dockPort);
        const ref = Math.abs(f.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        const u = V.vnorm(V.vcross(ref, f));
        const v = V.vnorm(V.vcross(f, u));
        return { f, u, v, R: st.radius };
      },
      place(pos, lookDir, upHint) {
        const w = window.VF.world; const V = window.VF.vec;
        const e = w.sim.entities.get(w.playerId);
        e.dockedAt = null; e.cruise = 'off'; e.cruiseSpeed = 0;
        e.pos = { ...pos }; e.prevPos = { ...pos }; e.vel = { x: 0, y: 0, z: 0 };
        e.orient = V.qLookAt(V.vnorm(lookDir), upHint || { x: 0, y: 1, z: 0 });
        e.prevOrient = { ...e.orient };
      },
    };
  });

  // ---- player ship beauty shot: daylit terran surface, chase cam ----
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const e = w.sim.entities.get(w.playerId);
    const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
    const un = V.vnorm({ x: 0.3, y: 0.9, z: 0.18 });
    const pos = V.vadd(p.pos, V.vscale(un, p.radius + 900));
    const horiz = V.vnorm(V.vcross(un, { x: 1, y: 0, z: 0 }));
    window.IN.place(pos, horiz, un);
    e.throttle = 0.5;
  });
  await page.keyboard.press('KeyV'); // chase
  await sleep(900);
  await shot('00_ship_chase');
  await page.keyboard.press('KeyV');
  await sleep(300);

  // ---- station: morrow_granary (terran neighbour, lit) ----
  const stInfo = await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const st = w.system.stations.find((s) => s.id === 'morrow_granary') || w.system.stations[0];
    const fr = window.IN.frame(st);
    const mouth = V.vadd(st.pos, V.vscale(fr.f, fr.R * 0.92));
    // exterior: 5.5 km out in front of the hatch, slightly above
    const pos = V.vadd(V.vadd(mouth, V.vscale(fr.f, 5500)), V.vscale(fr.v, 700));
    window.IN.place(pos, V.vscale(fr.f, -1), fr.v);
    return { id: st.id, R: fr.R };
  });
  console.log('station', JSON.stringify(stInfo));
  await sleep(900);
  await shot('01_hangar_exterior');

  // closer: 2.2 km out, centred on the slot
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const st = w.system.stations.find((s) => s.id === 'morrow_granary');
    const fr = window.IN.frame(st);
    const mouth = V.vadd(st.pos, V.vscale(fr.f, fr.R * 0.92));
    window.IN.place(V.vadd(mouth, V.vscale(fr.f, 2200)), V.vscale(fr.f, -1), fr.v);
  });
  await sleep(700);
  await shot('02_hangar_mouth');

  // inside the hangar, just past the mouth, looking in toward the pad
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const st = w.system.stations.find((s) => s.id === 'morrow_granary');
    const fr = window.IN.frame(st);
    const inside = V.vadd(st.pos, V.vscale(fr.f, fr.R * 0.55));
    window.IN.place(V.vadd(inside, V.vscale(fr.v, 200)), V.vscale(fr.f, -1), fr.v);
  });
  await sleep(700);
  await shot('03_hangar_interior');

  // chase cam on the pad (VTOL + gear) to see the ship sitting in the bay
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const sim = w.sim; const meta = sim.meta(w.playerId);
    const st = w.system.stations.find((s) => s.id === 'morrow_granary');
    const fr = window.IN.frame(st);
    const pad = V.vadd(V.vadd(st.pos, V.vscale(fr.f, fr.R * 0.47)), V.vscale(fr.v, -fr.R * 0.26 + 120));
    meta.vtol = true; meta.gearDown = true;
    window.IN.place(pad, V.vscale(fr.f, -1), fr.v);
  });
  await page.keyboard.press('KeyV'); // chase
  await sleep(800);
  await shot('04_on_pad_chase');
  await page.keyboard.press('KeyV');
  await sleep(300);

  // ---- atmosphere: on a terran surface in daylight ----
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
    const up = { x: 0.3, y: 0.9, z: 0.18 };
    const un = V.vnorm(up);
    const pos = V.vadd(p.pos, V.vscale(un, p.radius + 60));
    // look at the horizon (perpendicular to up)
    const look = V.vnorm(V.vcross(un, { x: 1, y: 0, z: 0 }));
    window.IN.place(pos, look, un);
  });
  await sleep(1200);
  await shot('05_surface_daylight_horizon');

  // terrain relief: ~1.5 km up, nose pitched down toward the ground
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
    const un = V.vnorm({ x: 0.3, y: 0.9, z: 0.18 });
    const pos = V.vadd(p.pos, V.vscale(un, p.radius + 1500));
    const horiz = V.vnorm(V.vcross(un, { x: 1, y: 0, z: 0 }));
    const look = V.vnorm(V.vadd(horiz, V.vscale(un, -0.7))); // pitched down ~35°
    window.IN.place(pos, look, un);
  });
  await sleep(1000);
  await shot('05b_terrain_relief');

  // sweep yaw to scan the sky for any planets bleeding through the fog
  await page.evaluate(() => { window.VF.botInput = { thrustForward: 0, thrustRight: 0, thrustUp: 0, pitch: 0.15, yaw: 0.6, roll: 0, brake: false }; });
  await sleep(1500);
  await page.evaluate(() => { delete window.VF.botInput; });
  await sleep(400);
  await shot('06_surface_sky_scan');

  // control: the day-lit side from space — planets visible, cloud layer on show
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
    const sun = V.vnorm(V.vscale(p.pos, -1)); // toward the star = the lit hemisphere
    const off = V.vnorm({ x: sun.z, y: 0.5, z: -sun.x });
    const dir = V.vnorm(V.vadd(sun, V.vscale(off, 0.5)));
    const pos = V.vadd(p.pos, V.vscale(dir, p.radius + 700000));
    window.IN.place(pos, V.vscale(dir, -1), { x: 0, y: 1, z: 0 });
  });
  await sleep(900);
  await shot('07_space_control');

  // cross-system spacing: sit out past the outer orbit and look toward the star,
  // so the whole system is roughly in front — are the planets crowded or distant?
  for (const [n, planetId] of [['08_spacing_from_morrow', 'morrow'], ['09_spacing_from_halcyon', 'halcyon']]) {
    await page.evaluate((pid) => {
      const w = window.VF.world; const V = window.VF.vec;
      const p = w.system.planets.find((pp) => pp.id === pid) || w.system.planets[2];
      const out = V.vnorm({ x: p.pos.x, y: 0, z: p.pos.z }); // radially outward
      const pos = V.vadd(p.pos, V.vscale(out, p.radius + 3_000_000)); // 3000 km off the world
      const look = V.vnorm(V.vsub({ x: 0, y: 0, z: 0 }, pos)); // toward the star/system
      window.IN.place(pos, look, { x: 0, y: 1, z: 0 });
    }, planetId);
    await sleep(900);
    await shot(n);
  }

  // VTOL hover aid: hovering over a planet surface, gear down, drifting a touch
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const sim = w.sim; const meta = sim.meta(w.playerId);
    const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
    const un = V.vnorm({ x: 0.3, y: 0.9, z: 0.18 });
    const pos = V.vadd(p.pos, V.vscale(un, p.radius + 600));
    const horiz = V.vnorm(V.vcross(un, { x: 1, y: 0, z: 0 }));
    window.IN.place(pos, horiz, un);
    meta.vtol = true; meta.gearDown = true;
    try { window.VF.app.camera.mode = 'cockpit'; } catch (e) { /* best effort */ }
  });
  await page.evaluate(() => { window.VF.botInput = { thrustForward: 0, thrustRight: 0.22, thrustUp: -0.25, pitch: 0, yaw: 0, roll: 0, brake: false }; });
  await sleep(700);
  await shot('10_vtol_aid');
  await page.evaluate(() => { delete window.VF.botInput; });

  // landing dust: sit just over the terrain in VTOL with some throttle
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const sim = w.sim; const meta = sim.meta(w.playerId);
    const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
    const un = V.vnorm({ x: 0.3, y: 0.9, z: 0.18 });
    const pos = V.vadd(p.pos, V.vscale(un, p.radius + 30)); // below the terrain → lands on it
    const horiz = V.vnorm(V.vcross(un, { x: 1, y: 0, z: 0 }));
    meta.vtol = true; meta.gearDown = true;
    window.IN.place(pos, horiz, un);
    try { window.VF.app.camera.mode = 'chase'; } catch (e) { /* */ }
  });
  await page.evaluate(() => { window.VF.botInput = { thrustForward: 0.5, thrustRight: 0, thrustUp: 0, pitch: 0, yaw: 0, roll: 0, brake: false }; });
  await sleep(900);
  await shot('11_landing_dust');
  await page.evaluate(() => { delete window.VF.botInput; });

  // ---- approach from space: the atmospheric halo arcing the planet's limb ----
  await page.evaluate(() => {
    const w = window.VF.world; const V = window.VF.vec;
    const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
    // the lit hemisphere faces the star at the origin: sit on that side, well
    // back, so the planet is a 3/4 disc with the glowing limb clearly arcing it
    const toSun = V.vnorm(V.vscale(p.pos, -1));
    const side = V.vnorm(V.vcross(toSun, { x: 0, y: 1, z: 0 }));
    const dir = V.vnorm(V.vadd(V.vscale(toSun, 0.7), V.vadd(V.vscale(side, 0.5), { x: 0, y: 0.35, z: 0 })));
    const pos = V.vadd(p.pos, V.vscale(dir, p.radius + 900_000)); // ~900 km out
    const look = V.vnorm(V.vsub(p.pos, pos));
    window.IN.place(pos, look, { x: 0, y: 1, z: 0 });
  });
  await sleep(1000);
  await shot('12_entry_space');

  // ---- atmospheric entry transition: descend the day side, nose down, fast.
  //      Captures the surface resolving + the re-entry plasma sheath. ----
  for (const altKm of [70, 45, 22, 9]) {
    await page.evaluate((altKm) => {
      const w = window.VF.world; const V = window.VF.vec;
      const p = w.system.planets.find((pp) => pp.kind === 'terran') || w.system.planets[2];
      const sun = V.vnorm(V.vscale(p.pos, -1)); // lit hemisphere
      const un = V.vnorm({ x: sun.x * 0.6 + 0.2, y: 0.78, z: sun.z * 0.6 + 0.1 });
      const pos = V.vadd(p.pos, V.vscale(un, p.radius + altKm * 1000));
      const horiz = V.vnorm(V.vcross(un, { x: 1, y: 0, z: 0 }));
      const look = V.vnorm(V.vadd(horiz, V.vscale(un, -0.45))); // ~25° descent view, like a pilot picking a spot
      window.IN.place(pos, look, un);
      const e = w.sim.entities.get(w.playerId);
      e.vel = V.vscale(look, 360); // diving fast → entry heat
    }, altKm);
    await sleep(900);
    const lc = await page.evaluate(() => { try { return window.VF.app.quadtree?.leafCount ?? -1; } catch (e) { return -2; } });
    console.log(`  ${altKm}km leafCount=${lc}`);
    await shot(`12_entry_${altKm}km`);
  }

  await browser.close();
  server.close();
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
