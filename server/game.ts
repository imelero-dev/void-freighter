// Authoritative world server: runs the shared Sim at 20 Hz, broadcasts
// interest-filtered snapshots at 10 Hz, persists players + market state.

import type { WebSocket } from 'ws';
import { PROFILE_EVERY_SNAPS, SNAPSHOT_EVERY_TICKS, wireEntity, wireShip, type WireEntity } from '../src/net/protocol';
import { MODULE_NAMES } from '../src/sim/data';
import { Sim } from '../src/sim/sim';
import { DT, type HullId, type ModuleSlot, type PlayerProfile, type SimEvent } from '../src/sim/types';
import { vdist } from '../src/sim/vec';
import type { Db } from './db';

const AUTOSAVE_S = 30;
const MARKET_SAVE_S = 60;
const STATION_PUSH_S = 3;
const EVENT_RADIUS = 30_000;
const CHAT_LOCAL_RADIUS = 50_000;
const TICK_EMA_ALPHA = 0.05;

export interface ClientSession {
  ws: WebSocket;
  accountId: number;
  pid: number;
  name: string;
  lastSaveAt: number;
  joinedAt: number;
  snapCounter: number;
  stationPushAcc: number;
}

interface MarketBlob {
  economy: ReturnType<Sim['economy']['serialize']>;
  time: number;
}

export class GameServer {
  sim = new Sim();
  clients = new Map<number, ClientSession>(); // by pid
  tickMsAvg = 0;
  private interval: NodeJS.Timeout | null = null;
  private saveTimer = 0;
  private marketTimer = 0;
  private readonly startedAt = Date.now();

  constructor(private db: Db) {}

  async init(): Promise<void> {
    const blob = (await this.db.loadMarketState()) as MarketBlob | null;
    if (blob?.economy) {
      this.sim.economy.restore(blob.economy);
      this.sim.time = blob.time ?? 0;
      console.log(`market state restored (t=${Math.round(this.sim.time)}s)`);
    }
  }

  start(): void {
    let last = process.hrtime.bigint();
    let acc = 0;
    this.interval = setInterval(() => {
      const now = process.hrtime.bigint();
      let dt = Number(now - last) / 1e9;
      last = now;
      if (dt > 0.5) dt = 0.5;
      acc += dt;
      while (acc >= DT) {
        const events = this.sim.tick();
        this.routeEvents(events);
        acc -= DT;
        if (this.sim.tickCount % SNAPSHOT_EVERY_TICKS === 0) this.broadcastSnapshots(dt);
      }
      const tickMs = Number(process.hrtime.bigint() - now) / 1e6;
      this.tickMsAvg = this.tickMsAvg === 0 ? tickMs : this.tickMsAvg + TICK_EMA_ALPHA * (tickMs - this.tickMsAvg);
      this.saveTimer += dt;
      if (this.saveTimer >= AUTOSAVE_S) {
        this.saveTimer = 0;
        void this.saveAll('autosave');
      }
      this.marketTimer += dt;
      if (this.marketTimer >= MARKET_SAVE_S) {
        this.marketTimer = 0;
        void this.saveMarket();
      }
    }, 50);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  // -------------------------------------------------------------------------

  join(ws: WebSocket, accountId: number, name: string, profile: PlayerProfile | null): ClientSession | { error: string } {
    for (const c of this.clients.values()) {
      if (c.accountId === accountId) return { error: 'this pilot is already flying (one session per account)' };
    }
    const pid = this.sim.addPlayer(name, profile ?? undefined);
    const session: ClientSession = {
      ws, accountId, pid, name,
      lastSaveAt: Date.now(), joinedAt: Date.now(), snapCounter: 0, stationPushAcc: 0,
    };
    this.clients.set(pid, session);
    const prof = this.sim.serializeProfile(pid)!;
    this.send(session, {
      t: 'hello', pid, seed: this.sim.cfg.seed, name, profile: prof,
    });
    this.broadcastSystemChat(`${name} entered the system.`);
    return session;
  }

  async leave(session: ClientSession, reason: string): Promise<void> {
    if (!this.clients.has(session.pid)) return;
    this.clients.delete(session.pid);
    await this.savePlayer(session).catch((err) => console.error('save on leave failed:', err));
    this.sim.removePlayer(session.pid);
    this.broadcastSystemChat(`${session.name} left the system. (${reason})`);
  }

  async savePlayer(session: ClientSession): Promise<void> {
    const profile = this.sim.serializeProfile(session.pid);
    if (profile) {
      await this.db.savePlayer(session.accountId, session.name, profile);
      session.lastSaveAt = Date.now();
    }
  }

  async saveAll(reason: string): Promise<void> {
    for (const session of this.clients.values()) {
      await this.savePlayer(session).catch((err) => console.error(`${reason} failed for ${session.name}:`, err));
    }
  }

  async saveMarket(): Promise<void> {
    const blob: MarketBlob = { economy: this.sim.economy.serialize(), time: this.sim.time };
    await this.db.saveMarketState(blob).catch((err) => console.error('market save failed:', err));
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  handleMessage(session: ClientSession, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const sim = this.sim;
    const pid = session.pid;
    if (msg.t === 'input' && Array.isArray(msg.i) && msg.i.length >= 7) {
      sim.setInput(pid, {
        thrustForward: Number(msg.i[0]), thrustRight: Number(msg.i[1]), thrustUp: Number(msg.i[2]),
        pitch: Number(msg.i[3]), yaw: Number(msg.i[4]), roll: Number(msg.i[5]), brake: !!msg.i[6],
        turbo: !!msg.i[7],
      });
      return;
    }
    if (msg.t !== 'cmd') return;
    const int = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0);
    switch (msg.cmd) {
      case 'fire': sim.setFiring(pid, !!msg.on); break;
      case 'missile': sim.fireMissile(pid); break;
      case 'drill': sim.setDrill(pid, !!msg.on); break;
      case 'cruise': sim.toggleCruise(pid); break;
      case 'fa': sim.toggleFlightAssist(pid); break;
      case 'target': sim.setTarget(pid, msg.id === null ? null : int(msg.id)); break;
      case 'tab': sim.tabTarget(pid); break;
      case 'reticle': sim.targetReticle(pid); break;
      case 'dock': sim.requestDock(pid); break;
      case 'undock': sim.undock(pid); break;
      case 'rescue': sim.hailRescue(pid); break;
      case 'fuelcells': sim.useFuelCells(pid, int(msg.qty)); break;
      case 'repkit': sim.useRepairKit(pid); break;
      case 'buy': if (typeof msg.good === 'string') sim.buyGood(pid, msg.good, int(msg.qty)); break;
      case 'sell': if (typeof msg.good === 'string') sim.sellGood(pid, msg.good, int(msg.qty)); break;
      case 'refine': if (typeof msg.good === 'string') sim.refine(pid, msg.good, int(msg.qty)); break;
      case 'refuel': sim.refuel(pid); break;
      case 'repair': sim.repairHull(pid); break;
      case 'restock': sim.restockMissiles(pid); break;
      case 'ammo': sim.restockCannonAmmo(pid); break;
      case 'derelict': sim.openDerelict(pid, int(msg.id)); break;
      case 'buyinfo': if (typeof msg.id === 'string') sim.buyStationInfo(pid, msg.id.slice(0, 64)); break;
      case 'rentws': sim.rentWorkshop(pid); break;
      case 'craft':
        if (typeof msg.slot === 'string' && msg.slot in MODULE_NAMES) sim.craftModule(pid, msg.slot as ModuleSlot, int(msg.tier));
        break;
      case 'craftkit': sim.craftRepairKit(pid); break;
      case 'buyplot': sim.buyWarehousePlot(pid); break;
      case 'whdep': if (typeof msg.good === 'string') sim.warehouseDeposit(pid, msg.good, int(msg.qty)); break;
      case 'whwit': if (typeof msg.good === 'string') sim.warehouseWithdraw(pid, msg.good, int(msg.qty)); break;
      case 'accept': if (typeof msg.id === 'string') sim.acceptContract(pid, msg.id); break;
      case 'abandon': if (typeof msg.id === 'string') sim.abandonContract(pid, msg.id); break;
      case 'deliver': if (typeof msg.id === 'string') sim.deliverSupply(pid, msg.id); break;
      case 'buymod':
        if (typeof msg.slot === 'string' && msg.slot in MODULE_NAMES) sim.buyModule(pid, msg.slot as ModuleSlot, int(msg.tier));
        break;
      case 'sellmod':
        if (typeof msg.slot === 'string' && msg.slot in MODULE_NAMES) sim.sellModule(pid, msg.slot as ModuleSlot);
        break;
      case 'stashinstall': sim.installStashModule(pid, int(msg.i)); break;
      case 'stashsell': sim.sellStashModule(pid, int(msg.i)); break;
      case 'buyhull': if (typeof msg.id === 'string') sim.buyHull(pid, msg.id as HullId); break;
      case 'dest': {
        if (msg.dest === null) {
          sim.setDestination(pid, null);
        } else if (msg.dest && typeof msg.dest === 'object') {
          const d = msg.dest;
          const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
          if (typeof d.name === 'string' && d.pos && typeof d.kind === 'string') {
            sim.setDestination(pid, {
              kind: ['station', 'planet', 'field', 'entity', 'point'].includes(d.kind) ? d.kind : 'point',
              id: typeof d.id === 'string' ? d.id.slice(0, 64) : '',
              name: d.name.slice(0, 64),
              pos: { x: num(d.pos.x), y: num(d.pos.y), z: num(d.pos.z) },
            });
          }
        }
        break;
      }
      case 'chat': if (typeof msg.text === 'string') sim.chat(pid, msg.text); break;
      case 'markets': {
        const meta = sim.meta(pid);
        if (!meta) break;
        const data: Record<string, unknown> = {};
        for (const stId of meta.profile.knownStations) {
          const m = sim.marketFor(stId);
          if (m) data[stId] = m;
        }
        this.send(session, { t: 'markets', data });
        break;
      }
      // dev/test commands — only with ALLOW_DEV_COMMANDS=1, never in production
      case 'dev_credits': {
        if (process.env.ALLOW_DEV_COMMANDS === '1') {
          const meta = sim.meta(pid);
          if (meta) meta.profile.credits += int(msg.amount);
        }
        break;
      }
      case 'dev_teleport': {
        if (process.env.ALLOW_DEV_COMMANDS === '1') {
          const e = sim.entities.get(pid);
          const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
          if (e && !e.dockedAt) {
            e.pos = { x: num(msg.x), y: num(msg.y), z: num(msg.z) };
            e.prevPos = { ...e.pos };
            e.vel = { x: 0, y: 0, z: 0 };
          }
        }
        break;
      }
      case 'dev_give': {
        if (process.env.ALLOW_DEV_COMMANDS === '1' && typeof msg.good === 'string') {
          const meta = sim.meta(pid);
          if (meta) sim.addCargo(meta.profile, msg.good, Math.max(1, Math.min(500, int(msg.qty))));
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots & events
  // -------------------------------------------------------------------------

  private broadcastSnapshots(dt: number): void {
    for (const session of this.clients.values()) {
      const p = this.sim.entities.get(session.pid);
      const meta = this.sim.meta(session.pid);
      if (!p || !meta) continue;
      const interest = Math.max(meta.stats.sensorRange * 1.2, 15_000);
      const ents: WireEntity[] = [];
      for (const e of this.sim.entities.values()) {
        if (e.id === session.pid || e.kind === 'asteroid') continue;
        if (vdist(p.pos, e.pos) > interest) continue;
        ents.push(wireEntity(e));
      }
      session.snapCounter++;
      const selfWire = wireShip(p);
      selfWire.tb = Math.round(meta.turboCharge * 100);
      if (meta.turboActive) selfWire.ta = 1;
      const snap: Record<string, unknown> = {
        t: 'snap', tick: this.sim.tickCount, time: Math.round(this.sim.time * 100) / 100,
        self: selfWire, ents,
        // clients generate pristine rocks deterministically; sync only damage
        rocks: this.sim.touchedRocks(),
      };
      if (session.snapCounter % PROFILE_EVERY_SNAPS === 1) {
        snap.profile = this.sim.serializeProfile(session.pid);
        snap.dest = meta.destination;
        snap.fa = meta.flightAssist ? 1 : 0;
        snap.drill = meta.drillOn ? 1 : 0;
        snap.news = this.sim.newsLog.slice(0, 8);
      }
      this.send(session, snap);

      // docked: push market + board periodically
      session.stationPushAcc += dt * SNAPSHOT_EVERY_TICKS;
      if (p.dockedAt && session.stationPushAcc >= STATION_PUSH_S) {
        session.stationPushAcc = 0;
        this.pushStation(session, p.dockedAt);
      }
    }
  }

  pushStation(session: ClientSession, stationId: string): void {
    const market = this.sim.marketFor(stationId);
    if (!market) return;
    this.send(session, {
      t: 'station', stationId, market, board: this.sim.boardFor(stationId),
    });
  }

  private routeEvents(events: SimEvent[]): void {
    if (events.length === 0 || this.clients.size === 0) return;
    // docking completed: push that station's market/board right away
    for (const ev of events) {
      if (ev.type === 'docked') {
        const session = this.clients.get(ev.pid);
        if (session) this.pushStation(session, ev.stationId);
      }
    }
    for (const session of this.clients.values()) {
      const p = this.sim.entities.get(session.pid);
      if (!p) continue;
      const mine: SimEvent[] = [];
      for (const ev of events) {
        if (ev.type === 'chat') {
          // channel routing overrides pid targeting
          const senderE = ev.pid !== undefined ? this.sim.entities.get(ev.pid) : null;
          if (ev.channel === 'system') mine.push(ev);
          else if (ev.channel === 'station') {
            if (senderE?.dockedAt && senderE.dockedAt === p.dockedAt) mine.push(ev);
          } else if (senderE && vdist(senderE.pos, p.pos) <= CHAT_LOCAL_RADIUS) {
            mine.push(ev);
          }
          continue;
        }
        if ('pid' in ev && ev.pid !== undefined) {
          if (ev.pid === session.pid) mine.push(ev);
          continue;
        }
        const anchor = this.eventAnchor(ev);
        if (anchor === null || vdist(p.pos, anchor) <= EVENT_RADIUS) mine.push(ev);
      }
      if (mine.length > 0) this.send(session, { t: 'events', list: mine });
    }
  }

  private eventAnchor(ev: SimEvent): { x: number; y: number; z: number } | null {
    if ('x' in ev && typeof ev.x === 'number') return { x: ev.x, y: (ev as any).y, z: (ev as any).z };
    if (ev.type === 'laser') {
      const from = this.sim.entities.get(ev.fromId);
      return from ? from.pos : { x: ev.toX, y: ev.toY, z: ev.toZ };
    }
    if ('entityId' in ev && typeof ev.entityId === 'number') {
      return this.sim.entities.get(ev.entityId)?.pos ?? null;
    }
    return null; // econ/log etc: broadcast
  }

  private broadcastSystemChat(text: string): void {
    for (const session of this.clients.values()) {
      this.send(session, { t: 'events', list: [{ type: 'chat', from: '', text, channel: 'system' }] });
    }
  }

  private send(session: ClientSession, obj: unknown): void {
    if (session.ws.readyState === 1) {
      session.ws.send(JSON.stringify(obj));
    }
  }

  status(): { ok: boolean; players_online: number; names: string[]; uptime_s: number; tick_ms: number } {
    return {
      ok: true,
      players_online: this.clients.size,
      names: [...this.clients.values()].map((s) => s.name),
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      tick_ms: Math.round(this.tickMsAvg * 100) / 100,
    };
  }
}
