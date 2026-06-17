// Generates the PWA icons (public/icon-192.png, public/icon-512.png) from
// the favicon's amber-ship-on-black design — no image deps, raw PNG + zlib.
//
//   node scripts/gen_icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PUB = resolve(import.meta.dirname, '..', 'public');

// favicon path on a 16×16 grid: M3 11 8 3l5 8-5-2z (a concave "dart")
const SHIP = [[3, 11], [8, 3], [13, 11], [8, 9]];
const BG = [0, 0, 0];
const AMBER = [0xd9, 0xa4, 0x41];

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 4×4 supersampling for clean edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = ((x + (sx + 0.5) / SS) / size) * 16;
          const gy = ((y + (sy + 0.5) / SS) / size) * 16;
          if (inPoly(gx, gy, SHIP)) cover++;
        }
      }
      const a = cover / (SS * SS);
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(BG[0] + (AMBER[0] - BG[0]) * a);
      rgba[o + 1] = Math.round(BG[1] + (AMBER[1] - BG[1]) * a);
      rgba[o + 2] = Math.round(BG[2] + (AMBER[2] - BG[2]) * a);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

// ---- minimal PNG writer (truecolor 8-bit RGBA, single IDAT) ----

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // raw scanlines, filter byte 0 per row
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = resolve(PUB, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log(`wrote ${file}`);
}
