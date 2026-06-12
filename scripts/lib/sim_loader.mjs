// Bundles the TS sim core with esbuild and imports it — lets the smoke bots
// drive the real game logic from plain node scripts.

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadSim() {
  const root = resolve(import.meta.dirname, '..', '..');
  const outDir = resolve(root, 'dist-server');
  mkdirSync(outDir, { recursive: true });
  const outfile = resolve(outDir, 'sim_bundle.mjs');
  await build({
    entryPoints: [resolve(root, 'scripts/lib/sim_entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href + `?v=${Date.now()}`);
}
