// Procedural canvas icons for goods and modules — no image files.

import { GOODS } from '../sim/data';
import type { ModuleSlot } from '../sim/types';

const cache = new Map<string, string>(); // key -> dataURL

const CATEGORY_HUES: Record<string, number> = {
  raw: 28, refined: 200, consumer: 90, industrial: 45, illegal: 0,
};

export function goodIcon(goodId: string): string {
  const key = `good_${goodId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = GOODS[goodId];
  const c = document.createElement('canvas');
  c.width = c.height = 28;
  const ctx = c.getContext('2d')!;
  const hue = CATEGORY_HUES[def?.category ?? 'raw'] ?? 28;
  const h2 = (hashStr(goodId) % 40) - 20;
  ctx.strokeStyle = `hsl(${hue + h2}, 45%, 55%)`;
  ctx.fillStyle = `hsla(${hue + h2}, 45%, 38%, 0.5)`;
  ctx.lineWidth = 1.5;
  ctx.translate(14, 14);
  const sides = 3 + (hashStr(goodId) % 4); // 3..6 sided shape per good
  ctx.beginPath();
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
    const r = 9 + ((hashStr(goodId + i) % 5) - 2);
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (def && !def.legal) {
    ctx.strokeStyle = '#cc3322';
    ctx.beginPath();
    ctx.moveTo(-10, 10);
    ctx.lineTo(10, -10);
    ctx.stroke();
  }
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

export function moduleIcon(slot: ModuleSlot): string {
  const key = `mod_${slot}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 28;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = '#7fa3b8';
  ctx.fillStyle = 'rgba(70, 100, 120, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.translate(14, 14);
  ctx.beginPath();
  switch (slot) {
    case 'engine':
      ctx.moveTo(-8, -8); ctx.lineTo(4, -8); ctx.lineTo(9, 0); ctx.lineTo(4, 8); ctx.lineTo(-8, 8);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.moveTo(-12, -4); ctx.lineTo(-8, -4); ctx.moveTo(-12, 4); ctx.lineTo(-8, 4); ctx.stroke();
      break;
    case 'gyro':
      ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, 8, 3, 0.6, 0, Math.PI * 2); ctx.stroke();
      break;
    case 'shield':
      ctx.arc(0, 1, 9, Math.PI * 0.85, Math.PI * 0.15, true); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 1, 6, Math.PI * 0.85, Math.PI * 0.15, true); ctx.stroke();
      break;
    case 'armor':
      ctx.rect(-8, -8, 16, 16); ctx.fill(); ctx.stroke();
      ctx.moveTo(-8, -2); ctx.lineTo(8, -2); ctx.moveTo(-8, 4); ctx.lineTo(8, 4); ctx.stroke();
      break;
    case 'cargo':
      ctx.rect(-9, -6, 8, 8); ctx.rect(1, -6, 8, 8); ctx.rect(-4, 3, 8, 8); ctx.stroke();
      break;
    case 'weapon':
      ctx.moveTo(-9, 5); ctx.lineTo(6, 5); ctx.lineTo(6, 1); ctx.lineTo(10, 1);
      ctx.moveTo(-9, 5); ctx.lineTo(-9, -2); ctx.lineTo(0, -2); ctx.stroke();
      break;
    case 'missile':
      ctx.moveTo(0, -10); ctx.lineTo(3, -4); ctx.lineTo(3, 6); ctx.lineTo(6, 10);
      ctx.lineTo(-6, 10); ctx.lineTo(-3, 6); ctx.lineTo(-3, -4); ctx.closePath(); ctx.stroke();
      break;
    case 'drill':
      ctx.moveTo(-7, -9); ctx.lineTo(7, -9); ctx.lineTo(2, 2); ctx.lineTo(0, 10); ctx.lineTo(-2, 2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      break;
    case 'collector':
      ctx.arc(0, 6, 3, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 6, 7, Math.PI, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 6, 11, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      break;
    case 'scanner':
      ctx.arc(0, 0, 9, -0.5, 0.5); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 5, -0.7, 0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9, -6); ctx.stroke();
      break;
    case 'fueltank':
      ctx.roundRect(-6, -9, 12, 18, 4); ctx.fill(); ctx.stroke();
      ctx.moveTo(-6, -3); ctx.lineTo(6, -3); ctx.stroke();
      break;
    case 'nav':
      ctx.moveTo(0, -9); ctx.lineTo(3, 3); ctx.lineTo(0, 1); ctx.lineTo(-3, 3); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.stroke();
      break;
  }
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
