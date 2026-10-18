// Offline-only HTML5 package for itch.io: builds the client in `itch` mode
// (no ONLINE panel, no /api or /ws calls), checks it against itch.io's HTML5
// upload rules and zips it with index.html at the zip root.
//
//   npm run build:itch     -> release/void-freighter-<version>-itch-html5.zip
//   npm run verify:itch    -> serves that zip in headless Chrome (see verify_itch.mjs)
//
// Nothing is uploaded: upload the zip by hand ("Kind of project: HTML",
// "This file will be played in the browser").

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { ROOT } from './lib/browser.mjs';
import { writeZip } from './lib/zip.mjs';

const OUT_DIR = join(ROOT, 'dist-itch');
const RELEASE_DIR = join(ROOT, 'release');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
export const ITCH_ZIP = join(RELEASE_DIR, `void-freighter-${version}-itch-html5.zip`);

// itch.io HTML5 upload limits (itch.io/docs/creators/html5)
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

function check(files) {
  const problems = [];
  const names = files.map((f) => relative(OUT_DIR, f).split(sep).join('/'));
  if (!names.includes('index.html')) problems.push('index.html missing at the package root');
  if (files.length > MAX_FILES) problems.push(`${files.length} files (itch.io max ${MAX_FILES})`);
  let total = 0;
  for (const [i, f] of files.entries()) {
    const size = statSync(f).size;
    total += size;
    if (size > MAX_FILE_BYTES) problems.push(`${names[i]} is ${size} bytes (max ${MAX_FILE_BYTES})`);
  }
  if (total > MAX_TOTAL_BYTES) problems.push(`${total} bytes extracted (max ${MAX_TOTAL_BYTES})`);

  // itch serves the game from a sub-path inside an iframe: root-absolute URLs
  // ("/assets/…") would 404 there
  const html = readFileSync(join(OUT_DIR, 'index.html'), 'utf8');
  for (const m of html.matchAll(/\b(?:src|href)="(\/[^"]*)"/g)) {
    if (!m[1].startsWith('//')) problems.push(`index.html uses a root-absolute path: ${m[1]}`);
  }
  // offline only: the online client must have been compiled out
  for (const [i, f] of files.entries()) {
    if (!f.endsWith('.js')) continue;
    const js = readFileSync(f, 'utf8');
    for (const needle of ['/api/', 'WebSocket(']) {
      if (js.includes(needle)) problems.push(`${names[i]} still contains "${needle}"`);
    }
  }
  return { names, total, problems };
}

async function main() {
  await build({ root: ROOT, mode: 'itch', logLevel: 'warn', build: { outDir: OUT_DIR, emptyOutDir: true } });
  const files = listFiles(OUT_DIR).sort();
  const { names, total, problems } = check(files);
  if (problems.length) {
    console.error(`✕ itch.io package check failed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  const zip = writeZip(files.map((f, i) => ({ name: names[i], data: readFileSync(f) })));
  mkdirSync(RELEASE_DIR, { recursive: true });
  writeFileSync(ITCH_ZIP, zip);
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(`✓ ${relative(ROOT, ITCH_ZIP)}  (${files.length} files, ${mb(total)} MB extracted, ${mb(zip.length)} MB zipped)`);
}

// pathToFileURL: a plain `file://${argv[1]}` never matches on Windows
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
