// Wire protocol shared by server and online client. Compact JSON messages.

import type { CruiseState, Entity, PirateTier, PlayerProfile, SimEvent } from '../sim/types';

export const SNAPSHOT_EVERY_TICKS = 2;   // 20 Hz sim -> 10 Hz snapshots
export const PROFILE_EVERY_SNAPS = 5;    // profile piggybacked at 2 Hz

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export interface InputMsg {
  t: 'input';
  // [thrustForward, thrustRight, thrustUp, pitch, yaw, roll, brake, turbo]
  i: [number, number, number, number, number, number, number, number];
}

export interface CmdMsg {
  t: 'cmd';
  cmd: string;
  [key: string]: unknown;
}

export interface AuthMsg {
  t: 'auth';
  token: string;
}

export type ClientMsg = AuthMsg | InputMsg | CmdMsg;

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

export interface WireShip {
  i: number; k: 's';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  q: [number, number, number, number];
  nm: string;
  hid: string;
  pir?: PirateTier;
  hl: number; mhl: number; sh: number; msh: number;
  th: number;
  cr: 0 | 1 | 2;
  cs: number;
  dk?: string;
  tg?: number;
  lk?: 1;
  lt?: number;
  ma?: number;
  ca?: number; // cannon ammo (self only)
  pl?: 1;  // is a player
  dl?: 1;  // derelict hulk
  cp?: 1;  // capital-class hull (superfreighter / armed cargo capital)
  tb?: number; // turbo charge ×100 (self only)
  ta?: 1;  // turbo active
}

export interface WireRock {
  fid: string;
  ridx: number;
  rhp: number;
}

export interface WireFloat {
  i: number; k: 'f' | 'l';
  x: number; y: number; z: number;
  g?: string; q?: number;
}

export interface WireMissile {
  i: number; k: 'm';
  x: number; y: number; z: number;
  qo: [number, number, number, number];
  tg: number | null;
}

export interface WireBolt {
  i: number; k: 'b';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

export type WireEntity = WireShip | WireFloat | WireMissile | WireBolt;

export interface SnapMsg {
  t: 'snap';
  tick: number;
  time: number;
  self: WireShip;
  ents: WireEntity[];
  rocks?: WireRock[]; // touched asteroids near the player (mined/destroyed)
  // piggybacked at low rate or when dirty:
  profile?: PlayerProfile;
  dest?: { kind: string; id: string; name: string; pos: { x: number; y: number; z: number } } | null;
  fa?: 0 | 1;      // flight assist
  drill?: 0 | 1;
  news?: string[];
}

export interface HelloMsg {
  t: 'hello';
  pid: number;
  seed: number;
  name: string;
  profile: PlayerProfile;
}

export interface EventsMsg {
  t: 'events';
  list: SimEvent[];
}

export interface StationMsg {
  t: 'station';
  stationId: string;
  market: Array<{ good: string; stock: number; buyPrice: number; sellPrice: number }>;
  board: unknown[]; // Contract[]
}

export interface MarketsMsg {
  t: 'markets';
  data: Record<string, Array<{ good: string; stock: number; buyPrice: number; sellPrice: number }>>;
}

export interface ErrorMsg {
  t: 'error';
  error: string;
}

export type ServerMsg = HelloMsg | SnapMsg | EventsMsg | StationMsg | MarketsMsg | ErrorMsg;

// ---------------------------------------------------------------------------
// serialization helpers
// ---------------------------------------------------------------------------

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function wireShip(e: Entity): WireShip {
  const w: WireShip = {
    i: e.id, k: 's',
    x: r2(e.pos.x), y: r2(e.pos.y), z: r2(e.pos.z),
    vx: r2(e.vel.x), vy: r2(e.vel.y), vz: r2(e.vel.z),
    q: [r3(e.orient.x), r3(e.orient.y), r3(e.orient.z), r3(e.orient.w)],
    nm: e.name, hid: e.hullId,
    hl: Math.round(e.hull), mhl: e.maxHull, sh: Math.round(e.shield), msh: e.maxShield,
    th: r2(e.throttle),
    cr: e.cruise === 'cruise' ? 2 : e.cruise === 'charging' ? 1 : 0,
    cs: Math.round(e.cruiseSpeed),
  };
  if (e.pirate) w.pir = e.pirate;
  if (e.dockedAt) w.dk = e.dockedAt;
  if (e.targetId !== null) w.tg = e.targetId;
  if (e.lockedOn) w.lk = 1;
  if (e.lockTimer > 0) w.lt = Math.round(e.lockTimer * 10) / 10;
  w.ma = e.missileAmmo;
  w.ca = e.cannonAmmo;
  if (e.isPlayer) w.pl = 1;
  if (e.derelict) w.dl = 1;
  if (e.capital) w.cp = 1;
  return w;
}

export function wireEntity(e: Entity): WireEntity {
  switch (e.kind) {
    case 'ship':
    case 'asteroid': // asteroids sync via SnapMsg.rocks, never as wire entities
      return wireShip(e);
    case 'fragment':
      return { i: e.id, k: 'f', x: r2(e.pos.x), y: r2(e.pos.y), z: r2(e.pos.z), g: e.goodId ?? undefined, q: e.qty };
    case 'loot':
      return { i: e.id, k: 'l', x: r2(e.pos.x), y: r2(e.pos.y), z: r2(e.pos.z) };
    case 'missile':
      return {
        i: e.id, k: 'm', x: r2(e.pos.x), y: r2(e.pos.y), z: r2(e.pos.z),
        qo: [r3(e.orient.x), r3(e.orient.y), r3(e.orient.z), r3(e.orient.w)],
        tg: e.targetId,
      };
    case 'bolt':
      return {
        i: e.id, k: 'b', x: r2(e.pos.x), y: r2(e.pos.y), z: r2(e.pos.z),
        vx: r2(e.vel.x), vy: r2(e.vel.y), vz: r2(e.vel.z),
      };
  }
}

export function cruiseFromWire(cr: 0 | 1 | 2): CruiseState {
  return cr === 2 ? 'cruise' : cr === 1 ? 'charging' : 'off';
}
