// Online play: REST auth + WebSocket world mirror. ClientWorld implements
// IWorld by mirroring server snapshots; the own ship is predicted locally
// with the shared flight integrator and reconciled against server state.

import { shipStats, ROCK_TYPES, type ShipStats } from '../sim/data';
import { integrateFlight } from '../sim/flight';
import { blankEntity, defaultProfile, SHIP_RADIUS } from '../sim/sim';
import { dangerAt, generateSystem, rockSpawn } from '../sim/system';
import {
  emptyShipInput, type Contract, type Destination, type Entity, type HullId, type MarketEntry,
  type ModuleSlot, type PlayerProfile, type ShipInput, type SimEvent, type StationDef,
} from '../sim/types';
import { qclone, qnlerp, v3, vclone, vdist, type Vec3 } from '../sim/vec';
import { cruiseFromWire, type ServerMsg, type SnapMsg, type WireShip } from './protocol';
import type { IWorld } from '../world_api';

const INPUT_SEND_S = 0.05;
const FIELD_CHECK_S = 1;
const FIELD_RANGE = 14_000;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export class Api {
  token: string | null = null;
  username: string | null = null;

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
    return data;
  }

  async register(username: string, password: string): Promise<void> {
    const data = await this.post('/api/register', { username, password });
    this.token = data.token;
    this.username = data.username;
  }

  async login(username: string, password: string): Promise<void> {
    const data = await this.post('/api/login', { username, password });
    this.token = data.token;
    this.username = data.username;
  }
}

export function buildWebSocketUrl(protocol: string, host: string): string {
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

export async function connectOnline(username: string, password: string, register: boolean): Promise<IWorld> {
  const api = new Api();
  if (register) await api.register(username, password);
  else await api.login(username, password);
  const world = new ClientWorld(api.token!, api.username!);
  await world.ready;
  return world;
}

// ---------------------------------------------------------------------------

export class ClientWorld implements IWorld {
  readonly online = true;
  system = generateSystem();
  entities = new Map<number, Entity>();
  playerId = -1;
  profile: PlayerProfile = defaultProfile();
  input: ShipInput = emptyShipInput();
  newsLog: string[] = [];
  destination: Destination | null = null;
  flightAssist = true;
  drillOn = false;
  connected = false;
  time = 0;
  ready: Promise<void>;

  private ws!: WebSocket;
  private eventQueue: SimEvent[] = [];
  private statsCache: ShipStats = shipStats('shuttle', {});
  private statsKey = '';
  private lastSnapAt = 0;
  private snapInterval = 100; // ms, adapts
  private inputAcc = 0;
  private fieldAcc = 0;
  private serverSelf: WireShip | null = null;
  private targetLockUntil = 0; // ignore server target echo briefly after local set
  private rockEntityIds = new Map<string, number>(); // "fid:idx" -> local entity id
  private nextLocalId = -1;
  private marketCache = new Map<string, MarketEntry[]>();
  private boardCache = new Map<string, Contract[]>();
  private lastMarketsReq = 0;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private closed = false;

  constructor(private token: string, public pilotName: string) {
    this.ready = new Promise((ok, bad) => {
      this.resolveReady = ok;
      this.rejectReady = bad;
    });
    this.connect();
  }

  private connect(): void {
    this.ws = new WebSocket(buildWebSocketUrl(location.protocol, location.host));
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ t: 'auth', token: this.token }));
    };
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.closed) return;
      if (wasConnected) {
        this.eventQueue.push({ type: 'chat', from: '', text: 'Connection lost — reconnecting…', channel: 'system' });
        setTimeout(() => this.connect(), 3000);
      }
    };
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }

  // -------------------------------------------------------------------------
  // IWorld getters
  // -------------------------------------------------------------------------

  get player(): Entity | null {
    return this.entities.get(this.playerId) ?? null;
  }

  get shipStats(): ShipStats {
    const key = this.profile.hullId + JSON.stringify(this.profile.modules);
    if (key !== this.statsKey) {
      this.statsKey = key;
      this.statsCache = shipStats(this.profile.hullId, this.profile.modules);
    }
    return this.statsCache;
  }

  get dockedStation(): StationDef | null {
    const at = this.player?.dockedAt;
    return at ? this.system.stations.find((s) => s.id === at) ?? null : null;
  }

  get renderAlpha(): number {
    if (this.lastSnapAt === 0) return 1;
    return Math.min(1, (performance.now() - this.lastSnapAt) / this.snapInterval);
  }

  drainEvents(): SimEvent[] {
    const out = this.eventQueue;
    this.eventQueue = [];
    return out;
  }

  dangerAt(pos: Vec3): number {
    return dangerAt(this.system, pos);
  }

  market(stationId: string): MarketEntry[] | null {
    if (!this.profile.knownStations.includes(stationId)) return null;
    const hit = this.marketCache.get(stationId);
    if (!hit && performance.now() - this.lastMarketsReq > 5000) {
      this.lastMarketsReq = performance.now();
      this.cmd({ cmd: 'markets' });
    }
    return hit ?? null;
  }

  board(stationId: string): Contract[] {
    return this.boardCache.get(stationId) ?? [];
  }

  // -------------------------------------------------------------------------
  // Frame update: input send + own-ship prediction + local rock fields
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (!this.connected || this.playerId < 0) return;
    this.inputAcc += dt;
    if (this.inputAcc >= INPUT_SEND_S) {
      this.inputAcc = 0;
      if (this.ws.readyState === WebSocket.OPEN) {
        const i = this.input;
        this.ws.send(JSON.stringify({
          t: 'input',
          i: [r3(i.thrustForward), r3(i.thrustRight), r3(i.thrustUp), r3(i.pitch), r3(i.yaw), r3(i.roll), i.brake ? 1 : 0],
        }));
      }
    }

    const e = this.entities.get(this.playerId);
    const sv = this.serverSelf;
    if (e && sv) {
      const serverControlled = sv.dk !== undefined || sv.cr !== 0;
      if (serverControlled) {
        // docked / docking / cruising: follow the server smoothly
        const k = 1 - Math.exp(-dt * 8);
        e.pos.x += (sv.x - e.pos.x) * k;
        e.pos.y += (sv.y - e.pos.y) * k;
        e.pos.z += (sv.z - e.pos.z) * k;
        e.vel = v3(sv.vx, sv.vy, sv.vz);
        e.orient = qnlerp(e.orient, { x: sv.q[0], y: sv.q[1], z: sv.q[2], w: sv.q[3] }, 1 - Math.exp(-dt * 6));
      } else {
        // predict locally with the shared integrator
        integrateFlight(e, this.input, this.shipStats, dt, this.flightAssist);
        // reconcile against extrapolated server state
        const age = (performance.now() - this.lastSnapAt) / 1000;
        const sx = sv.x + sv.vx * age, sy = sv.y + sv.vy * age, sz = sv.z + sv.vz * age;
        const err = Math.hypot(e.pos.x - sx, e.pos.y - sy, e.pos.z - sz);
        if (err > 400) {
          e.pos = v3(sx, sy, sz);
          e.vel = v3(sv.vx, sv.vy, sv.vz);
        } else {
          const k = 1 - Math.exp(-dt * (err > 30 ? 6 : 1.2));
          e.pos.x += (sx - e.pos.x) * k;
          e.pos.y += (sy - e.pos.y) * k;
          e.pos.z += (sz - e.pos.z) * k;
        }
        e.orient = qnlerp(e.orient, { x: sv.q[0], y: sv.q[1], z: sv.q[2], w: sv.q[3] }, 1 - Math.exp(-dt * 2));
      }
      // self renders without snapshot interpolation
      e.prevPos = vclone(e.pos);
      e.prevOrient = qclone(e.orient);
    }

    this.fieldAcc += dt;
    if (this.fieldAcc >= FIELD_CHECK_S) {
      this.fieldAcc = 0;
      this.updateLocalFields();
    }
  }

  // Deterministic client-side asteroid fields (pristine rocks); server syncs
  // only damaged/destroyed rocks via snap.rocks.
  private updateLocalFields(): void {
    const e = this.player;
    if (!e) return;
    const wanted = new Set<string>();
    for (const belt of this.system.belts) {
      for (const f of belt.fields) {
        if (vdist(e.pos, f.pos) < f.radius + FIELD_RANGE) wanted.add(f.id);
      }
    }
    // remove rocks of fields out of range
    for (const [key, id] of [...this.rockEntityIds]) {
      const fid = key.slice(0, key.lastIndexOf(':'));
      if (!wanted.has(fid)) {
        this.entities.delete(id);
        this.rockEntityIds.delete(key);
      }
    }
    for (const fid of wanted) {
      const field = this.system.belts.flatMap((b) => b.fields).find((f) => f.id === fid)!;
      const belt = this.system.belts.find((b) => b.id === field.beltId)!;
      for (let i = 0; i < field.rockCount; i++) {
        const key = `${fid}:${i}`;
        if (this.rockEntityIds.has(key)) continue;
        const spawn = rockSpawn(field, belt, i);
        const rock = blankEntity(this.nextLocalId--, 'asteroid');
        rock.pos = vclone(spawn.pos);
        rock.prevPos = vclone(spawn.pos);
        rock.radius = spawn.radius;
        rock.rockType = spawn.type;
        rock.rockMaxHp = spawn.radius * ROCK_TYPES[spawn.type].hpPerRadius;
        rock.rockHp = rock.rockMaxHp;
        rock.fieldId = fid;
        rock.rockIndex = i;
        rock.name = `${spawn.type} asteroid`;
        // approximate remaining yield readout for the scanner
        const def = ROCK_TYPES[spawn.type];
        const total = spawn.radius * def.yieldPerRadius;
        let wsum = 0;
        for (const y of def.yields) wsum += y.weight;
        rock.rockYield = {};
        for (const y of def.yields) rock.rockYield[y.good] = Math.round(total * (y.weight / wsum));
        this.entities.set(rock.id, rock);
        this.rockEntityIds.set(key, rock.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  private cmd(payload: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'cmd', ...payload }));
    }
  }

  private onMessage(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello': {
        this.playerId = msg.pid;
        this.profile = msg.profile;
        this.pilotName = msg.name;
        this.connected = true;
        // create own entity
        const e = blankEntity(msg.pid, 'ship');
        e.isPlayer = true;
        e.name = msg.name;
        e.hullId = msg.profile.hullId;
        e.radius = SHIP_RADIUS[msg.profile.hullId];
        e.pos = vclone(msg.profile.pos);
        e.prevPos = vclone(msg.profile.pos);
        e.dockedAt = msg.profile.dockedAt;
        this.entities.set(msg.pid, e);
        this.resolveReady();
        break;
      }
      case 'error': {
        this.connected = false;
        this.rejectReady(new Error(msg.error));
        this.eventQueue.push({ type: 'chat', from: '', text: `Server: ${msg.error}`, channel: 'system' });
        break;
      }
      case 'snap':
        this.applySnapshot(msg);
        break;
      case 'events':
        for (const ev of msg.list) this.eventQueue.push(ev);
        break;
      case 'station':
        this.marketCache.set(msg.stationId, msg.market as MarketEntry[]);
        this.boardCache.set(msg.stationId, msg.board as Contract[]);
        break;
      case 'markets':
        for (const [stId, entries] of Object.entries(msg.data)) {
          this.marketCache.set(stId, entries as MarketEntry[]);
        }
        break;
    }
  }

  private applySnapshot(snap: SnapMsg): void {
    const now = performance.now();
    if (this.lastSnapAt > 0) {
      const gap = now - this.lastSnapAt;
      if (gap > 5 && gap < 1000) this.snapInterval = this.snapInterval * 0.9 + gap * 0.1;
    }
    this.lastSnapAt = now;
    this.time = snap.time;

    const seen = new Set<number>();
    for (const w of snap.ents) {
      seen.add(w.i);
      let e = this.entities.get(w.i);
      switch (w.k) {
        case 's': {
          if (!e) {
            e = blankEntity(w.i, 'ship');
            e.pos = v3(w.x, w.y, w.z);
            e.orient = { x: w.q[0], y: w.q[1], z: w.q[2], w: w.q[3] };
            this.entities.set(w.i, e);
          }
          e.prevPos = vclone(e.pos);
          e.prevOrient = qclone(e.orient);
          e.pos = v3(w.x, w.y, w.z);
          e.vel = v3(w.vx, w.vy, w.vz);
          e.orient = { x: w.q[0], y: w.q[1], z: w.q[2], w: w.q[3] };
          e.name = w.nm;
          e.hullId = w.hid as HullId | 'pirate';
          e.pirate = w.pir ?? null;
          e.isPlayer = !!w.pl;
          e.radius = SHIP_RADIUS[w.hid] ?? 12;
          e.hull = w.hl;
          e.maxHull = w.mhl;
          e.shield = w.sh;
          e.maxShield = w.msh;
          e.throttle = w.th;
          e.cruise = cruiseFromWire(w.cr);
          e.cruiseSpeed = w.cs;
          e.dockedAt = w.dk ?? null;
          e.derelict = !!w.dl;
          break;
        }
        case 'f':
        case 'l': {
          if (!e) {
            e = blankEntity(w.i, w.k === 'f' ? 'fragment' : 'loot');
            e.pos = v3(w.x, w.y, w.z);
            e.radius = w.k === 'f' ? 2 : 4;
            this.entities.set(w.i, e);
          }
          e.prevPos = vclone(e.pos);
          e.pos = v3(w.x, w.y, w.z);
          e.goodId = w.g ?? e.goodId;
          e.qty = w.q ?? e.qty;
          e.name = w.k === 'l' ? 'salvage' : (e.goodId ?? 'fragment');
          break;
        }
        case 'm': {
          if (!e) {
            e = blankEntity(w.i, 'missile');
            e.pos = v3(w.x, w.y, w.z);
            e.radius = 1.5;
            this.entities.set(w.i, e);
          }
          e.prevPos = vclone(e.pos);
          e.prevOrient = qclone(e.orient);
          e.pos = v3(w.x, w.y, w.z);
          e.orient = { x: w.qo[0], y: w.qo[1], z: w.qo[2], w: w.qo[3] };
          e.targetId = w.tg;
          break;
        }
        case 'b': {
          if (!e) {
            e = blankEntity(w.i, 'bolt');
            e.pos = v3(w.x, w.y, w.z);
            e.radius = 1;
            this.entities.set(w.i, e);
          }
          e.prevPos = vclone(e.pos);
          e.pos = v3(w.x, w.y, w.z);
          e.vel = v3(w.vx, w.vy, w.vz);
          break;
        }
      }
    }

    // self: authoritative combat/status state (movement reconciled in update)
    const e = this.entities.get(this.playerId);
    if (e && snap.self) {
      const s = snap.self;
      this.serverSelf = s;
      e.hull = s.hl;
      e.maxHull = s.mhl;
      e.shield = s.sh;
      e.maxShield = s.msh;
      e.cruise = cruiseFromWire(s.cr);
      e.cruiseSpeed = s.cs;
      e.dockedAt = s.dk ?? null;
      e.missileAmmo = s.ma ?? 0;
      e.cannonAmmo = s.ca ?? 0;
      e.lockedOn = !!s.lk;
      e.lockTimer = s.lt ?? 0;
      e.throttle = s.th;
      if (performance.now() > this.targetLockUntil) {
        e.targetId = s.tg ?? null;
      }
    }
    if (snap.profile) {
      this.profile = snap.profile;
      this.destination = (snap.dest as Destination | null) ?? null;
      this.flightAssist = snap.fa !== 0;
      this.drillOn = snap.drill === 1;
      if (snap.news) this.newsLog = snap.news;
    }

    // rocks: server list is the complete set of non-pristine rocks nearby
    if (snap.rocks) {
      const touched = new Map<string, number>();
      for (const r of snap.rocks) touched.set(`${r.fid}:${r.ridx}`, r.rhp);
      for (const [key, id] of [...this.rockEntityIds]) {
        const rock = this.entities.get(id);
        if (!rock) continue;
        const hp = touched.get(key);
        if (hp === undefined) {
          if (rock.rockHp < rock.rockMaxHp) rock.rockHp = rock.rockMaxHp; // respawned
        } else if (hp <= 0) {
          this.entities.delete(id);
          this.rockEntityIds.delete(key);
        } else {
          rock.rockHp = hp;
        }
      }
    }

    // prune entities that left our interest area (positive server ids only)
    for (const [id] of this.entities) {
      if (id > 0 && id !== this.playerId && !seen.has(id)) this.entities.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // IWorld commands -> network (optimistic where it helps responsiveness)
  // -------------------------------------------------------------------------

  setFiring(on: boolean): void {
    const e = this.player;
    if (e) e.firing = on;
    this.cmd({ cmd: 'fire', on });
  }
  fireMissile(): void { this.cmd({ cmd: 'missile' }); }
  setDrill(on: boolean): void {
    if (this.shipStats.drillRate > 0) this.drillOn = on;
    this.cmd({ cmd: 'drill', on });
  }
  toggleCruise(): void { this.cmd({ cmd: 'cruise' }); }
  toggleFlightAssist(): void {
    this.flightAssist = !this.flightAssist;
    this.cmd({ cmd: 'fa' });
  }
  setTarget(id: number | null): void {
    const e = this.player;
    if (e && (id === null || (id > 0 && this.entities.has(id)) || id < 0)) {
      e.targetId = id;
      this.targetLockUntil = performance.now() + 600;
    }
    // local asteroid ids are negative — translate to nothing server-side;
    // mining aims by reticle server-side, so target cmds only send server ids
    if (id === null || id > 0) this.cmd({ cmd: 'target', id });
  }
  tabTarget(): void { this.cmd({ cmd: 'tab' }); }
  targetReticle(): void {
    // local pick for instant feedback (asteroids are client-side entities)
    this.cmd({ cmd: 'reticle' });
  }
  requestDock(): void { this.cmd({ cmd: 'dock' }); }
  undock(): void { this.cmd({ cmd: 'undock' }); }
  setDestination(dest: Destination | null): void {
    this.destination = dest;
    this.cmd({ cmd: 'dest', dest });
  }
  hailRescue(): void { this.cmd({ cmd: 'rescue' }); }
  useFuelCells(qty: number): void { this.cmd({ cmd: 'fuelcells', qty }); }
  buyGood(goodId: string, qty: number): void { this.cmd({ cmd: 'buy', good: goodId, qty }); }
  sellGood(goodId: string, qty: number): void { this.cmd({ cmd: 'sell', good: goodId, qty }); }
  refine(inputGood: string, qty: number): void { this.cmd({ cmd: 'refine', good: inputGood, qty }); }
  refuel(): void { this.cmd({ cmd: 'refuel' }); }
  repairHull(): void { this.cmd({ cmd: 'repair' }); }
  restockMissiles(): void { this.cmd({ cmd: 'restock' }); }
  restockCannonAmmo(): void { this.cmd({ cmd: 'ammo' }); }
  openDerelict(entityId: number): void { this.cmd({ cmd: 'derelict', id: entityId }); }
  acceptContract(id: string): void { this.cmd({ cmd: 'accept', id }); }
  abandonContract(id: string): void { this.cmd({ cmd: 'abandon', id }); }
  deliverSupply(id: string): void { this.cmd({ cmd: 'deliver', id }); }
  buyModule(slot: ModuleSlot, tier: number): void { this.cmd({ cmd: 'buymod', slot, tier }); }
  sellModule(slot: ModuleSlot): void { this.cmd({ cmd: 'sellmod', slot }); }
  installStashModule(index: number): void { this.cmd({ cmd: 'stashinstall', i: index }); }
  sellStashModule(index: number): void { this.cmd({ cmd: 'stashsell', i: index }); }
  buyHull(hullId: HullId): void { this.cmd({ cmd: 'buyhull', id: hullId }); }
  chat(text: string): void { this.cmd({ cmd: 'chat', text }); }
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
