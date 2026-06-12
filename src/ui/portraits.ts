// Procedural shopkeeper portraits: seeded pixel-art faces drawn on canvas.
// No image assets — every station crew member is generated from its seed.

import { Rng } from '../sim/rng';
import type { StationDef } from '../sim/types';

export type KeeperRole = 'quartermaster' | 'broker' | 'dockmaster' | 'foreman';

export interface Keeper {
  img: string;      // dataURL
  name: string;
  role: string;
  line: string;     // greeting
}

const ROLE_LABEL: Record<KeeperRole, string> = {
  quartermaster: 'Quartermaster', broker: 'Contract Broker',
  dockmaster: 'Dockmaster', foreman: 'Refinery Foreman',
};

const GREETINGS: Record<KeeperRole, string[]> = {
  quartermaster: [
    'Prices are on the board. Crying about them is free.',
    'Buy it, sell it, or stop blocking my counter.',
    'Fresh stock, mostly legal. Mostly.',
    'You break the crate, you bought the crate.',
    'The margin is out there, pilot. Not in here.',
  ],
  broker: [
    'Cargo wants moving. You look desperate enough.',
    'Deadlines are not suggestions, pilot.',
    'Deliver on time and we will get along fine.',
    'Every job on that board outlived its last courier.',
    'Sign here. Try not to die with my freight aboard.',
  ],
  dockmaster: [
    'She will fly. How far is your problem.',
    'New plating, new drives, same old debt.',
    'I have seen worse hulls. Not many, though.',
    'Top tier parts, bottom tier prices. One of those is a lie.',
    'Your insurance premiums keep this yard open.',
  ],
  foreman: [
    'Ore goes in, metal comes out, the dust stays in my lungs.',
    'The smelter eats rock and credit margins.',
    'Refined pays better. You knew that, right?',
    'Mind the slag. It is still warm.',
    'Bring me iridium and I will remember your name.',
  ],
};

const SKIN = ['#c8a080', '#a87858', '#8a5c40', '#e0b896', '#6f4a34', '#b89070'];
const HAIR = ['#3a3230', '#1c1816', '#6e5a42', '#8a8a8a', '#4a3828', '#b0a294', '#7a3c2a'];
const SUIT = ['#4a5560', '#5a4f3a', '#6e3326', '#37474f', '#4e4a56', '#52606b'];
const VISOR = ['#7fb1c9', '#d9a441', '#88cc88', '#cc8866'];

const NAME_A = ['Var', 'Jes', 'Mor', 'Kel', 'Dra', 'Sol', 'Tam', 'Rig', 'Ode', 'Bren', 'Cas', 'Yul', 'Hek', 'Niv', 'Osk', 'Pell'];
const NAME_B = ['a', 'o', 'en', 'ar', 'is', 'ul', 'ek', 'im', 'ona', 'ette', 'rik', 'mar', 'ley', 'dan', 'va', 'go'];
const SURNAME = ['Voss', 'Harrow', 'Okafor', 'Reyes', 'Stahl', 'Mbeki', 'Kovac', 'Tanaka', 'Ferro', 'Lindqvist', 'Aiyer', 'Calloway', 'Drax', 'Iverson', 'Oduya', 'Wren'];

const roleSalt: Record<KeeperRole, number> = {
  quartermaster: 0x51, broker: 0xb2, dockmaster: 0xd3, foreman: 0xf4,
};

const cache = new Map<string, Keeper>();

export function keeperFor(station: StationDef, role: KeeperRole): Keeper {
  const key = `${station.id}_${role}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rng = new Rng((station.seed ^ (roleSalt[role] * 2654435761)) >>> 0);
  const keeper: Keeper = {
    img: drawPortrait(rng),
    name: `${rng.pick(NAME_A)}${rng.pick(NAME_B)} ${rng.pick(SURNAME)}`,
    role: ROLE_LABEL[role],
    line: rng.pick(GREETINGS[role]),
  };
  cache.set(key, keeper);
  return keeper;
}

// 32x32 pixel-art face, upscaled with hard pixels.
function drawPortrait(rng: Rng): string {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;

  // murky backdrop with a hint of panel lighting
  ctx.fillStyle = '#15181c';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = 'rgba(217, 164, 65, 0.08)';
  ctx.fillRect(0, 0, 32, rng.int(6, 12));

  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const suit = rng.pick(SUIT);

  // shoulders / jacket
  ctx.fillStyle = suit;
  ctx.fillRect(4, 24, 24, 8);
  ctx.fillStyle = shade(suit, -18);
  ctx.fillRect(4, 24, 24, 2);
  // collar
  ctx.fillStyle = shade(suit, 14);
  ctx.fillRect(12, 23, 8, 3);

  // neck + head
  ctx.fillStyle = shade(skin, -12);
  ctx.fillRect(13, 21, 6, 4);
  ctx.fillStyle = skin;
  const headW = rng.int(11, 13);
  const headX = 16 - Math.floor(headW / 2);
  ctx.fillRect(headX, 7, headW, 15);
  // jaw shading
  ctx.fillStyle = shade(skin, -10);
  ctx.fillRect(headX, 18, headW, 4);

  // ears
  ctx.fillStyle = skin;
  ctx.fillRect(headX - 1, 13, 1, 3);
  ctx.fillRect(headX + headW, 13, 1, 3);
  // comms earpiece sometimes
  if (rng.chance(0.4)) {
    ctx.fillStyle = '#d9a441';
    ctx.fillRect(headX + headW, 13, 2, 2);
  }

  // eyes: visor / goggles / patch / plain
  const eyeStyle = rng.next();
  const eyeY = 12;
  if (eyeStyle < 0.25) {
    // full visor
    ctx.fillStyle = rng.pick(VISOR);
    ctx.fillRect(headX + 1, eyeY - 1, headW - 2, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(headX + 2, eyeY - 1, 2, 1);
  } else {
    ctx.fillStyle = '#f4f0e8';
    ctx.fillRect(headX + 2, eyeY, 3, 2);
    ctx.fillRect(headX + headW - 5, eyeY, 3, 2);
    ctx.fillStyle = '#2a2420';
    ctx.fillRect(headX + 3, eyeY, 1, 2);
    ctx.fillRect(headX + headW - 4, eyeY, 1, 2);
    if (eyeStyle < 0.4) {
      // eyepatch over one eye
      ctx.fillStyle = '#1c1816';
      ctx.fillRect(headX + 1, eyeY - 1, 5, 4);
      ctx.fillRect(headX + 1, eyeY - 2, headW - 2, 1);
    }
    // brows
    ctx.fillStyle = hair;
    ctx.fillRect(headX + 2, eyeY - 2, 3, 1);
    ctx.fillRect(headX + headW - 5, eyeY - 2, 3, 1);
  }

  // nose + mouth
  ctx.fillStyle = shade(skin, -22);
  ctx.fillRect(15, 15, 2, 2);
  ctx.fillStyle = rng.chance(0.7) ? '#5a3a32' : shade(skin, -30);
  ctx.fillRect(14, 19, rng.int(3, 5), 1);

  // hair / helmet / cap / bald
  const hairStyle = rng.next();
  if (hairStyle < 0.3) {
    // hard hat / helmet
    ctx.fillStyle = rng.chance(0.5) ? '#b08a2a' : '#5a6a72';
    ctx.fillRect(headX - 1, 5, headW + 2, 4);
    ctx.fillRect(headX + 1, 3, headW - 2, 2);
  } else if (hairStyle < 0.75) {
    ctx.fillStyle = hair;
    ctx.fillRect(headX, 5, headW, 3);
    ctx.fillRect(headX, 8, 2, rng.int(2, 6));
    ctx.fillRect(headX + headW - 2, 8, 2, rng.int(2, 6));
  } else if (hairStyle < 0.88) {
    // buzz cut
    ctx.fillStyle = shade(hair, 10);
    ctx.fillRect(headX, 6, headW, 2);
  } // else bald

  // facial hair
  if (rng.chance(0.45)) {
    ctx.fillStyle = hair;
    ctx.fillRect(headX + 2, 18, headW - 4, rng.int(2, 4));
  }
  // scar
  if (rng.chance(0.3)) {
    ctx.fillStyle = shade(skin, -35);
    const sx = headX + rng.int(1, headW - 2);
    ctx.fillRect(sx, rng.int(9, 16), 1, rng.int(2, 4));
  }
  // grime
  for (let i = 0; i < 4; i++) {
    if (rng.chance(0.5)) {
      ctx.fillStyle = 'rgba(40, 32, 26, 0.35)';
      ctx.fillRect(rng.int(4, 27), rng.int(20, 30), rng.int(1, 3), 1);
    }
  }

  // upscale with hard pixels
  const out = document.createElement('canvas');
  out.width = out.height = 128;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(c, 0, 0, 128, 128);
  return out.toDataURL();
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
  const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
  return `rgb(${r},${g},${b})`;
}
