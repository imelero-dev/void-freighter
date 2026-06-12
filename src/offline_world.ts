// Offline play: the full Sim runs in the browser at a fixed timestep.
// Progress persists to localStorage.

import { Sim, defaultProfile } from './sim/sim';
import { DT, type Contract, type Destination, type Entity, type HullId, type MarketEntry, type ModuleSlot, type PlayerProfile, type ShipInput, type SimEvent, type StationDef } from './sim/types';
import type { Vec3 } from './sim/vec';
import type { IWorld } from './world_api';

const SAVE_KEY = 'void_freighter_save_v1';
const AUTOSAVE_S = 30;

interface SaveBlob {
  profile: PlayerProfile;
  economy: ReturnType<Sim['economy']['serialize']>;
  time: number;
  pilotName: string;
}

export class OfflineWorld implements IWorld {
  sim: Sim;
  playerId: number;
  readonly online = false;
  readonly connected = true;
  private acc = 0;
  private saveAcc = 0;
  private eventQueue: SimEvent[] = [];

  constructor(public pilotName: string, restore = true) {
    this.sim = new Sim();
    let profile: PlayerProfile | undefined;
    if (restore) {
      const blob = loadSave();
      if (blob) {
        profile = blob.profile;
        this.sim.economy.restore(blob.economy);
        this.sim.time = blob.time;
        this.pilotName = blob.pilotName || pilotName;
      }
    }
    this.playerId = this.sim.addPlayer(this.pilotName, profile);
  }

  static hasSave(): boolean {
    return loadSave() !== null;
  }

  static clearSave(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch { /* private mode */ }
  }

  get system() { return this.sim.system; }
  get entities() { return this.sim.entities; }
  get player(): Entity | null { return this.sim.entities.get(this.playerId) ?? null; }
  get profile(): PlayerProfile { return this.meta.profile; }
  get shipStats() { return this.meta.stats; }
  get destination(): Destination | null { return this.meta.destination; }
  get time(): number { return this.sim.time; }
  get newsLog(): string[] { return this.sim.newsLog; }
  get flightAssist(): boolean { return this.meta.flightAssist; }
  get drillOn(): boolean { return this.meta.drillOn; }
  get input(): ShipInput { return this.meta.input; }
  set input(v: ShipInput) { Object.assign(this.meta.input, v); }

  get dockedStation(): StationDef | null {
    const at = this.player?.dockedAt;
    return at ? this.sim.station(at) ?? null : null;
  }

  private get meta() {
    return this.sim.meta(this.playerId)!;
  }

  update(dt: number): void {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) {
      this.acc -= DT;
      const events = this.sim.tick();
      for (const ev of events) {
        // offline: keep only global events and our own
        if ('pid' in ev && ev.pid !== undefined && ev.pid !== this.playerId) continue;
        this.eventQueue.push(ev);
      }
    }
    this.saveAcc += dt;
    if (this.saveAcc >= AUTOSAVE_S) {
      this.saveAcc = 0;
      this.save();
    }
  }

  drainEvents(): SimEvent[] {
    const out = this.eventQueue;
    this.eventQueue = [];
    return out;
  }

  save(): void {
    const profile = this.sim.serializeProfile(this.playerId);
    if (!profile) return;
    const blob: SaveBlob = {
      profile,
      economy: this.sim.economy.serialize(),
      time: this.sim.time,
      pilotName: this.pilotName,
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
    } catch { /* storage full / private mode: play on without saves */ }
  }

  market(stationId: string): MarketEntry[] | null {
    // market data is only known for visited stations
    if (!this.profile.knownStations.includes(stationId)) return null;
    return this.sim.marketFor(stationId);
  }

  board(stationId: string): Contract[] {
    return this.sim.boardFor(stationId);
  }

  dangerAt(pos: Vec3): number {
    return this.sim.dangerAt(pos);
  }

  // ---- commands: direct passthrough ----
  setFiring(on: boolean): void { this.sim.setFiring(this.playerId, on); }
  fireMissile(): void { this.sim.fireMissile(this.playerId); }
  setDrill(on: boolean): void { this.sim.setDrill(this.playerId, on); }
  toggleCruise(): void { this.sim.toggleCruise(this.playerId); }
  toggleFlightAssist(): void { this.sim.toggleFlightAssist(this.playerId); }
  setTarget(id: number | null): void { this.sim.setTarget(this.playerId, id); }
  tabTarget(): void { this.sim.tabTarget(this.playerId); }
  targetReticle(): void { this.sim.targetReticle(this.playerId); }
  requestDock(): void { this.sim.requestDock(this.playerId); }
  undock(): void { this.sim.undock(this.playerId); }
  setDestination(dest: Destination | null): void { this.sim.setDestination(this.playerId, dest); }
  hailRescue(): void { this.sim.hailRescue(this.playerId); }
  useFuelCells(qty: number): void { this.sim.useFuelCells(this.playerId, qty); }
  buyGood(goodId: string, qty: number): void { this.sim.buyGood(this.playerId, goodId, qty); }
  sellGood(goodId: string, qty: number): void { this.sim.sellGood(this.playerId, goodId, qty); }
  refine(inputGood: string, qty: number): void { this.sim.refine(this.playerId, inputGood, qty); }
  refuel(): void { this.sim.refuel(this.playerId); }
  repairHull(): void { this.sim.repairHull(this.playerId); }
  restockMissiles(): void { this.sim.restockMissiles(this.playerId); }
  acceptContract(id: string): void { this.sim.acceptContract(this.playerId, id); }
  abandonContract(id: string): void { this.sim.abandonContract(this.playerId, id); }
  deliverSupply(id: string): void { this.sim.deliverSupply(this.playerId, id); }
  buyModule(slot: ModuleSlot, tier: number): void { this.sim.buyModule(this.playerId, slot, tier); }
  sellModule(slot: ModuleSlot): void { this.sim.sellModule(this.playerId, slot); }
  installStashModule(index: number): void { this.sim.installStashModule(this.playerId, index); }
  sellStashModule(index: number): void { this.sim.sellStashModule(this.playerId, index); }
  buyHull(hullId: HullId): void { this.sim.buyHull(this.playerId, hullId); }
  chat(text: string): void { this.sim.chat(this.playerId, text); }
}

function loadSave(): SaveBlob | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw) as SaveBlob;
    if (!blob.profile || !blob.economy) return null;
    // forward-compat: merge missing profile fields from defaults
    blob.profile = { ...defaultProfile(), ...blob.profile };
    return blob;
  } catch {
    return null;
  }
}
