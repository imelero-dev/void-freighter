// The deterministic game core. The same Sim runs offline in the browser and
// authoritatively inside the Node server. No DOM, no Math.random.

import {
  AMMO_PRICE, ASTEROID_RESPAWN_S, BOLT_SPEED, COLLISION_DAMAGE_SPEED, CRUISE_CHARGE_S, CRUISE_ACCEL_DOUBLE_S,
  CRUISE_DROP_SPEED, CRUISE_FUEL_PER_S, CRUISE_MIN_SPEED, DOCK_MAX_SPEED, FUEL_PRICE,
  COMBAT_LOCKOUT_S, CRAFT_RECIPES, craftMaterials, GOODS, HULLS, INSURANCE_DEDUCTIBLE, MISSILE_PRICE, MODULE_SELL_FACTOR, PIRATES, PLAYER_AIM_SPREAD,
  DRILL_COOL_PER_S, DRILL_HEAT_PER_S, DRILL_OVERHEAT_RESUME, HOTSPOT_CONE, MINING_RATE_FACTOR,
  NPC_DEFS, ORE_CHANCE_BASE, ORE_CHANCE_HOTSPOT, REPAIR_KIT_FRACTION, REPAIR_KIT_RECIPE, WAREHOUSE_PLOT_M3, WORKSHOP_RENT_PRICE, WORKSHOP_RENT_S, warehousePlotPrice,
  TURBO_ACCEL_MULT, TURBO_BURST_S, TURBO_ENEMY_RADIUS, TURBO_RECHARGE_S, TURBO_SPEED,
  PIRATE_GOOD_DROPS, REFINE_RECIPES, REPAIR_PRICE, REP_DISCOUNT_MAX, REP_SMUGGLING_PENALTY,
  RESCUE_COST_FRACTION, RESCUE_COST_MIN, ROCK_TYPES, SHIELD_REGEN_DELAY,
  SMUGGLING_INSPECTION_CHANCE, STATION_TURRET_DPS, STARTER_MODULES, modulePrice, shipStats,
  shipValue, type ShipStats,
} from './data';
import { MODULE_NAMES } from './data';
import { integrateFlight } from './flight';
import { ContractBoards } from './contracts';
import { Economy } from './economy';
import { Rng } from './rng';
import { dangerAt, generateSystem, rockSpawn, stationInfoCost, WORLD_SEED } from './system';
import { TrafficSystem } from './traffic';
import {
  DT, emptyShipInput, type CargoItem, type Contract, type Destination, type Entity,
  type EntityKind, type HullId, type MarketEntry, type ModuleSlot, type PirateTier,
  type PlayerProfile, type ShipInput, type SimEvent, type StationDef,
} from './types';
import {
  angleBetween, clamp, leadPoint, qclone, qForward, qident, qIntegrate, qLookAt, qnorm, qrot,
  v3, vadd, vclone, vdist, vdot, vlen, vlen2, vnorm, vscale, vsub, type Vec3,
} from './vec';

export const SHIP_RADIUS: Record<string, number> = {
  shuttle: 10, hauler: 16, prospector: 14, interceptor: 12, freighter: 26, pirate: 13,
};

const FRAGMENT_CHUNK = 3;        // mined units per fragment entity
const FRAGMENT_TTL = 150;
const LOOT_TTL = 240;
const MISSILE_SPEED = 700;
const MISSILE_TURN = 2.8;        // rad/s
const MISSILE_TTL = 14;
const MISSILE_LOCK_RANGE = 3200;
const MISSILE_LOCK_CONE = 0.3;   // rad
const AIM_CONE_MIN = 0.035;      // rad — base hitscan aim tolerance
const PIRATE_DESPAWN_RANGE = 30_000;
const PIRATE_CHECK_S = 6;
const FIELD_ACTIVATE_MARGIN = 14_000;
const PICKUP_DIST = 55;
const STAR_BURN_RADIUS_MULT = 1.6;
const RESCUE_DELAY_S = 8;

const DERELICT_NAMES = ['Pale Wager', 'Long Comedown', 'Saint Brassica', 'Iron Promise', 'Quiet Ledger', 'Last Shift', 'Glass Harvest', 'Hollow Crown'];

const DERELICT_STORIES = [
  'The cabin is dark. The logbook\'s last entry, forty days old: "The knocking from the hold has stopped. I find I miss it." The cargo door was welded shut — from the outside.',
  'Life support died years ago, but the galley table is set for three. Two trays are untouched. The third has been licked clean. The crew manifest lists two names.',
  'Every screen aboard shows the same coordinates, typed over and over. The pilot\'s chair is empty. The pilot\'s suit is still strapped into it.',
  'A voice loop plays on the bridge: "...it followed us through the Veilshard. Do not open the hold. Do not open the—" The recording is older than the ship.',
  'The hull is scorched in long parallel lines, like something held it. Inside, the cargo straps are all buckled — from whatever pushed its way out.',
  'Someone scratched tally marks into the airlock wall. Three hundred and six. Beneath them, in steadier handwriting: "wrong about the rescue."',
];

const COMMS_LINES = [
  '…anyone on this band? I am reading two contacts where there should be none…',
  'Automated beacon VSP-9: do not approach. Do not approach. Do not approa—',
  '…sold the spare drive for scrap. Now it is just me and the long drift home.',
  'Meridian control, freight seven-seven requesting corridor… Meridian control? …hello?',
  '—lost the heading hours ago. The stars all look the same out here.',
  'If you can hear this: the Shatter took my wing. Do not fly it alone.',
  '…day forty-one. Recycler is holding. Talking to the static keeps me sane.',
  'Khar Terminal advisory: keep your transponder lit past the Veilshard.',
  'They say the Scrappers strip hulls with the crew still breathing. Keep your distance.',
  'This is freighter Dawn Ledger, cargo of grain, please respond… anyone…',
  '…repeating: fuel state critical, drifting sunward of the Ironline… repeating…',
  'Whoever keeps pinging channel six: stop. There is nothing out here. Stop looking.',
  'Helion dispatch to all freelancers: another hauler went dark near Rusthaven last night.',
  '…it has been following me for an hour. It does not answer hails. It just follows.',
  'Static. Then, faintly: a child counting backwards from one hundred. Then static.',
];

// ---------------------------------------------------------------------------
// Entity factory
// ---------------------------------------------------------------------------

export function blankEntity(id: number, kind: EntityKind): Entity {
  return {
    id, kind, pos: v3(), vel: v3(), angVel: v3(), prevPos: v3(),
    orient: qident(), prevOrient: qident(), name: '',
    isPlayer: false, pirate: null, npc: null, factionId: '', hullId: 'shuttle',
    hull: 1, maxHull: 1, shield: 0, maxShield: 0, shieldRegenTimer: 99,
    targetId: null, firing: false, weaponCooldown: 0, dead: false,
    throttle: 0, cruise: 'off', cruiseSpeed: 0, dockedAt: null,
    aiState: 'patrol', aggroId: null, spawnPos: v3(), aiTimer: 0,
    aiPhase: 0, missileCooldown: 0,
    missileAmmo: 0, cannonAmmo: 0, lockTimer: 0, lockedOn: false,
    parentId: 0, derelict: false, derelictOpened: false,
    rockType: null, rockHp: 0, rockMaxHp: 0, rockYield: null, hotspots: null, fieldId: null, rockIndex: -1,
    radius: 10, goodId: null, qty: 0, lootCredits: 0, lootModule: null, ttl: 0,
    ownerId: 0, damage: 0,
  };
}

export function defaultProfile(): PlayerProfile {
  return {
    credits: 2000,
    hullId: 'shuttle',
    modules: { ...STARTER_MODULES },
    hullHp: HULLS.shuttle.baseHull,
    fuel: 100,
    cargo: [],
    contracts: [],
    reputation: {},
    dockedAt: 'morrow_granary',
    respawnStation: 'morrow_granary',
    pos: v3(),
    knownStations: ['morrow_granary'],
    moduleStash: [],
    missileAmmo: 0,
    cannonAmmo: 320, // full magazine for the starter Mk I cannon
    workshopRentals: {},
    warehouses: {},
    stats: {
      kills: 0, contractsDone: 0, unitsMined: 0, unitsTraded: 0,
      creditsEarned: 0, deaths: 0, distanceTravelled: 0,
    },
  };
}

export interface PlayerMeta {
  pid: number;
  name: string;
  profile: PlayerProfile;
  input: ShipInput;
  firing: boolean;
  drillOn: boolean;
  destination: Destination | null;
  docking: { stationId: string; t: number; from: Vec3 } | null;
  undockInvuln: number;
  interdictCooldown: number;
  commsTimer: number;
  wreckTimer: number;
  pirateCheckTimer: number;
  extractAcc: number;
  stats: ShipStats;
  rescueTimer: number;     // >0: tow inbound
  cruiseRequested: boolean;
  flightAssist: boolean;
  forcefieldCooldown: number;
  promptedDerelicts: Set<number>;
  turboCharge: number;   // 0..1 burst gauge
  turboActive: boolean;
  lastCombatAt: number;  // sim time of the last hit taken (field-repair lockout)
  miningBeam: boolean;   // RMB held with the drill deployed
  beamFiring: boolean;   // beam actually firing this tick (drives FX/audio)
  drillHeat: number;     // 0..1 — overheats, cools when idle
  drillOverheated: boolean;
}

interface RockState {
  hp: number;
  yieldLeft: Record<string, number>;
  respawnAt: number; // sim time when it regrows (only when destroyed)
  entityId: number | null;
}

export interface SimConfig {
  seed: number;
}

// ---------------------------------------------------------------------------

export class Sim {
  cfg: SimConfig;
  system = generateSystem();
  economy: Economy;
  boards: ContractBoards;
  traffic: TrafficSystem;
  time = 0;
  tickCount = 0;
  entities = new Map<number, Entity>();
  players = new Map<number, PlayerMeta>();
  newsLog: string[] = [];
  private nextId = 1;
  private events: SimEvent[] = [];
  rng: Rng; // shared with subsystems (traffic)
  private rocks = new Map<string, RockState>();      // "fieldId:idx" -> state
  private activeFields = new Set<string>();
  private secondAcc = 0;

  constructor(cfg?: Partial<SimConfig>) {
    this.cfg = { seed: cfg?.seed ?? WORLD_SEED };
    this.system = generateSystem(this.cfg.seed);
    this.economy = new Economy(this.system);
    this.boards = new ContractBoards(this.system);
    this.rng = new Rng(this.cfg.seed ^ 0xdead);
    this.traffic = new TrafficSystem(this);
    this.boards.tick(0);
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  addPlayer(name: string, profile?: PlayerProfile): number {
    const pid = this.nextId++;
    const prof = profile ?? defaultProfile();
    // forward-compat for profiles saved before these systems existed
    prof.workshopRentals ??= {};
    prof.warehouses ??= {};
    prof.moduleStash ??= [];
    prof.cannonAmmo ??= 0;
    const e = blankEntity(pid, 'ship');
    e.isPlayer = true;
    e.name = name;
    e.hullId = prof.hullId;
    e.radius = SHIP_RADIUS[prof.hullId];
    const meta: PlayerMeta = {
      pid, name, profile: prof, input: emptyShipInput(), firing: false, drillOn: false,
      destination: null, docking: null, undockInvuln: 0, interdictCooldown: 0,
      commsTimer: 90 + this.rng.range(0, 120), wreckTimer: 150 + this.rng.range(0, 180),
      pirateCheckTimer: this.rng.range(0, PIRATE_CHECK_S),
      extractAcc: 0, stats: shipStats(prof.hullId, prof.modules), rescueTimer: 0,
      cruiseRequested: false, flightAssist: true,
      forcefieldCooldown: 0, promptedDerelicts: new Set(),
      turboCharge: 1, turboActive: false, lastCombatAt: -999,
      miningBeam: false, beamFiring: false, drillHeat: 0, drillOverheated: false,
    };
    e.maxHull = meta.stats.maxHull;
    e.maxShield = meta.stats.maxShield;
    e.hull = clamp(prof.hullHp, 1, e.maxHull);
    e.shield = e.maxShield;
    e.missileAmmo = prof.missileAmmo;
    e.cannonAmmo = Math.min(prof.cannonAmmo ?? 0, meta.stats.cannonAmmoMax);
    e.factionId = 'independent';
    if (prof.dockedAt && this.station(prof.dockedAt)) {
      e.dockedAt = prof.dockedAt;
      e.pos = vclone(this.station(prof.dockedAt)!.pos);
    } else {
      e.pos = vclone(prof.pos);
    }
    this.entities.set(pid, e);
    this.players.set(pid, meta);
    return pid;
  }

  removePlayer(pid: number): void {
    this.serializeProfile(pid); // sync entity state into profile first
    this.entities.delete(pid);
    this.players.delete(pid);
  }

  meta(pid: number): PlayerMeta | undefined {
    return this.players.get(pid);
  }

  // subsystem hooks (traffic)
  emit(ev: SimEvent): void {
    this.events.push(ev);
  }

  spawnShipEntity(): Entity {
    const e = blankEntity(this.nextId++, 'ship');
    this.entities.set(e.id, e);
    return e;
  }

  // Sync live entity state into the profile and return it (for persistence).
  serializeProfile(pid: number): PlayerProfile | null {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e) return null;
    meta.profile.pos = vclone(e.pos);
    meta.profile.hullHp = e.hull;
    meta.profile.dockedAt = e.dockedAt;
    meta.profile.missileAmmo = e.missileAmmo;
    meta.profile.cannonAmmo = e.cannonAmmo;
    return meta.profile;
  }

  station(id: string): StationDef | undefined {
    return this.system.stations.find((s) => s.id === id);
  }

  recomputeStats(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e) return;
    meta.stats = shipStats(meta.profile.hullId, meta.profile.modules);
    e.hullId = meta.profile.hullId;
    e.radius = SHIP_RADIUS[meta.profile.hullId];
    e.maxHull = meta.stats.maxHull;
    e.maxShield = meta.stats.maxShield;
    e.hull = Math.min(e.hull, e.maxHull);
    e.shield = Math.min(e.shield, e.maxShield);
    e.cannonAmmo = Math.min(e.cannonAmmo, meta.stats.cannonAmmoMax);
    meta.profile.cannonAmmo = e.cannonAmmo;
    meta.profile.fuel = Math.min(meta.profile.fuel, meta.stats.fuelMax);
  }

  // -------------------------------------------------------------------------
  // Cargo helpers
  // -------------------------------------------------------------------------

  cargoVolume(profile: PlayerProfile): number {
    let v = 0;
    for (const c of profile.cargo) v += GOODS[c.good].volume * c.qty;
    return v;
  }

  cargoFree(pid: number): number {
    const meta = this.players.get(pid)!;
    return meta.stats.cargoCapacity - this.cargoVolume(meta.profile);
  }

  freeQty(profile: PlayerProfile, goodId: string): number {
    // units not reserved by a contract
    return profile.cargo.filter((c) => c.good === goodId && !c.contractId)
      .reduce((s, c) => s + c.qty, 0);
  }

  addCargo(profile: PlayerProfile, goodId: string, qty: number, contractId?: string): void {
    const slot = profile.cargo.find((c) => c.good === goodId && c.contractId === contractId);
    if (slot) slot.qty += qty;
    else profile.cargo.push(contractId ? { good: goodId, qty, contractId } : { good: goodId, qty });
  }

  removeCargo(profile: PlayerProfile, goodId: string, qty: number, contractId?: string): boolean {
    let need = qty;
    const matches = profile.cargo.filter((c) => c.good === goodId && (contractId === undefined ? !c.contractId : c.contractId === contractId));
    const have = matches.reduce((s, c) => s + c.qty, 0);
    if (have < need) return false;
    for (const c of matches) {
      const take = Math.min(c.qty, need);
      c.qty -= take;
      need -= take;
      if (need <= 0) break;
    }
    profile.cargo = profile.cargo.filter((c) => c.qty > 0);
    return true;
  }

  cargoValue(profile: PlayerProfile): number {
    return profile.cargo.reduce((s, c) => s + GOODS[c.good].basePrice * c.qty, 0);
  }

  // -------------------------------------------------------------------------
  // Reputation
  // -------------------------------------------------------------------------

  repOf(profile: PlayerProfile, factionId: string): number {
    return profile.reputation[factionId] ?? 0;
  }

  addRep(profile: PlayerProfile, factionId: string, delta: number): void {
    profile.reputation[factionId] = clamp((profile.reputation[factionId] ?? 0) + delta, -100, 100);
  }

  // price multiplier for services at a station (rep discount)
  discount(profile: PlayerProfile, st: StationDef): number {
    const rep = this.repOf(profile, st.factionId);
    if (rep <= 0) return 1;
    return 1 - Math.min(rep, 50) / 50 * REP_DISCOUNT_MAX;
  }

  // -------------------------------------------------------------------------
  // Main tick
  // -------------------------------------------------------------------------

  tick(): SimEvent[] {
    const dt = DT;
    this.time += dt;
    this.tickCount++;

    // render interpolation bases
    for (const e of this.entities.values()) {
      e.prevPos.x = e.pos.x;
      e.prevPos.y = e.pos.y;
      e.prevPos.z = e.pos.z;
      e.prevOrient = qclone(e.orient);
    }

    const econEvent = this.economy.tick(this.time, dt);
    if (econEvent) {
      this.newsLog.unshift(econEvent.headline);
      if (this.newsLog.length > 12) this.newsLog.pop();
      this.events.push({ type: 'econ', headline: econEvent.headline });
    }
    this.boards.tick(this.time);

    this.updateFieldActivation();

    // per-second housekeeping
    this.secondAcc += dt;
    const secondTick = this.secondAcc >= 1;
    if (secondTick) this.secondAcc -= 1;

    for (const meta of this.players.values()) {
      this.tickPlayer(meta, dt, secondTick);
    }

    this.traffic.tick(dt, secondTick);

    for (const e of [...this.entities.values()]) {
      switch (e.kind) {
        case 'ship':
          if (e.derelict) {
            // inert hulk: slow drift, eventually fades into the dark
            e.ttl -= dt;
            vaddTo(e.pos, vscale(e.vel, dt));
            if (e.ttl <= 0) this.entities.delete(e.id);
          } else if (e.npc) {
            this.traffic.tickNpc(e, dt);
          } else if (!e.isPlayer) {
            this.tickPirate(e, dt);
          }
          break;
        case 'missile': this.tickMissile(e, dt); break;
        case 'bolt': this.tickBolt(e, dt); break;
        case 'fragment':
        case 'loot': this.tickFloating(e, dt); break;
        case 'asteroid': {
          // respawn handled in field activation
          break;
        }
      }
    }

    // combat resolution for all ships
    for (const e of this.entities.values()) {
      if (e.kind === 'ship' && !e.dead) this.tickShipCombat(e, dt);
    }

    if (secondTick) {
      this.tickStationTurrets();
      this.tickContracts();
    }

    const out = this.events;
    this.events = [];
    return out;
  }

  // -------------------------------------------------------------------------
  // Player tick
  // -------------------------------------------------------------------------

  private tickPlayer(meta: PlayerMeta, dt: number, secondTick: boolean): void {
    const e = this.entities.get(meta.pid);
    if (!e || e.dead) return;
    // re-asserted by tickMining further down; the early returns (towed,
    // docking, docked) must not leave a stale "firing" flag behind
    meta.beamFiring = false;
    const prof = meta.profile;
    meta.undockInvuln = Math.max(0, meta.undockInvuln - dt);
    meta.interdictCooldown = Math.max(0, meta.interdictCooldown - dt);

    // rescue tow
    if (meta.rescueTimer > 0) {
      meta.rescueTimer -= dt;
      if (meta.rescueTimer <= 0) {
        const st = this.nearestStation(e.pos);
        this.dockShip(meta, e, st, true);
        prof.fuel = Math.min(meta.stats.fuelMax, meta.stats.fuelMax * 0.25);
        this.events.push({ type: 'log', text: `Tow complete. Docked at ${st.name}.`, color: '#8fb', pid: meta.pid });
      }
      return; // being towed: no control
    }

    // docking autopilot
    if (meta.docking) {
      const st = this.station(meta.docking.stationId)!;
      meta.docking.t += dt / 3.5;
      const t = clamp(meta.docking.t, 0, 1);
      const ease = t * t * (3 - 2 * t);
      e.pos = {
        x: meta.docking.from.x + (st.pos.x - meta.docking.from.x) * ease,
        y: meta.docking.from.y + (st.pos.y - meta.docking.from.y) * ease,
        z: meta.docking.from.z + (st.pos.z - meta.docking.from.z) * ease,
      };
      e.vel = v3();
      if (t >= 1) {
        meta.docking = null;
        this.dockShip(meta, e, st, false);
      }
      return;
    }

    if (e.dockedAt) {
      // docked: fast shield regen, station keeps you safe
      e.shield = Math.min(e.maxShield, e.shield + meta.stats.shieldRegen * 5 * dt);
      return;
    }

    // ambient comms
    meta.commsTimer -= dt;
    if (meta.commsTimer <= 0) {
      meta.commsTimer = 110 + this.rng.range(0, 160);
      this.events.push({ type: 'comms', pid: meta.pid, text: this.rng.pick(COMMS_LINES) });
    }

    // derelict encounters: rare distress beacons in deep space. Salvage pays —
    // but sometimes the beacon is bait. If conditions are wrong (near a
    // station, at cruise) the roll is NOT consumed — retry shortly.
    meta.wreckTimer -= dt;
    if (meta.wreckTimer <= 0) {
      if (this.maybeSpawnWreck(meta, e)) meta.wreckTimer = 300 + this.rng.range(0, 300);
      else meta.wreckTimer = 25;
    }

    // flight
    if (e.cruise !== 'off') {
      meta.turboActive = false;
      this.tickCruise(meta, e, dt);
    } else {
      // turbo overburn: pinned throttle pushes past the speed cap — free when
      // alone, burst-gauge-limited with hostiles in knife range
      const wantsTurbo = meta.input.turbo && meta.input.thrustForward >= 0.99 && !meta.input.brake;
      let turbo = false;
      if (wantsTurbo) {
        let hostileNear = false;
        for (const h of this.entities.values()) {
          if (h.kind === 'ship' && h.pirate && h.pirate !== 'turret' && !h.dead
            && vdist(h.pos, e.pos) < TURBO_ENEMY_RADIUS) {
            hostileNear = true;
            break;
          }
        }
        if (!hostileNear) {
          turbo = true;
        } else if (meta.turboCharge > 0) {
          turbo = true;
          meta.turboCharge = Math.max(0, meta.turboCharge - dt / TURBO_BURST_S);
        }
      }
      // the gauge only recharges once you let go of the burn
      if (!turbo && !wantsTurbo) {
        meta.turboCharge = Math.min(1, meta.turboCharge + dt / TURBO_RECHARGE_S);
      }
      meta.turboActive = turbo;
      const perf = turbo
        ? { maxSpeed: TURBO_SPEED, accel: meta.stats.accel * TURBO_ACCEL_MULT, turnRate: meta.stats.turnRate }
        : meta.stats;
      this.integrateShip(e, meta.input, perf, dt, meta.flightAssist);
      if (meta.cruiseRequested) this.tryStartCruise(meta, e);
    }
    const moved = vlen(e.vel) * dt;
    prof.stats.distanceTravelled += moved;

    // collisions & hazards
    this.tickCollisions(meta, e, dt);

    // mining
    this.tickMining(meta, e, dt);

    // pickups (fragments & loot)
    this.tickPickups(meta, e);

    // shield regen
    e.shieldRegenTimer += dt;
    if (e.shieldRegenTimer > SHIELD_REGEN_DELAY) {
      e.shield = Math.min(e.maxShield, e.shield + meta.stats.shieldRegen * dt);
    }

    // missile lock progress
    this.tickLock(e, meta.stats, dt);

    // pirate spawning around this player
    if (secondTick) {
      meta.pirateCheckTimer -= 1;
      if (meta.pirateCheckTimer <= 0) {
        meta.pirateCheckTimer = PIRATE_CHECK_S;
        this.maybeSpawnPirates(meta, e);
      }
      // drifting close to a derelict triggers its story prompt (once)
      for (const d of this.entities.values()) {
        if (!d.derelict || d.derelictOpened || meta.promptedDerelicts.has(d.id)) continue;
        if (vdist(d.pos, e.pos) > 450) continue;
        meta.promptedDerelicts.add(d.id);
        const story = DERELICT_STORIES[d.id % DERELICT_STORIES.length];
        this.events.push({ type: 'derelict', pid: meta.pid, entityId: d.id, name: d.name, story });
      }
    }
  }

  // Player chose to breach a derelict's hold: coordinates to a salvage cache —
  // or a very bad time.
  openDerelict(pid: number, entityId: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    const d = this.entities.get(entityId);
    if (!meta || !e || !d || !d.derelict || d.derelictOpened) return;
    if (vdist(d.pos, e.pos) > 600) {
      this.events.push({ type: 'log', text: 'Too far from the derelict to board it.', color: '#fa4', pid });
      return;
    }
    d.derelictOpened = true;
    if (this.rng.chance(0.55)) {
      // coordinates to a salvage cache
      const dir = vnorm(v3(this.rng.range(-1, 1), this.rng.range(-0.3, 0.3), this.rng.range(-1, 1)));
      const cachePos = vadd(d.pos, vscale(dir, this.rng.range(18_000, 35_000)));
      const containers = this.rng.int(4, 6);
      for (let i = 0; i < containers; i++) {
        const loot = blankEntity(this.nextId++, 'loot');
        loot.pos = vadd(cachePos, v3(this.rng.range(-260, 260), this.rng.range(-140, 140), this.rng.range(-260, 260)));
        loot.ttl = 1500;
        loot.radius = 4;
        loot.name = 'cached salvage';
        loot.lootCredits = this.rng.int(120, 420);
        const drop = this.rng.pickWeighted(PIRATE_GOOD_DROPS, PIRATE_GOOD_DROPS.map((x) => x.weight));
        loot.goodId = drop.good;
        loot.qty = this.rng.int(drop.min, drop.max + 2);
        if (this.rng.chance(0.12)) {
          loot.lootModule = { slot: this.rng.pick(['shield', 'scanner', 'collector', 'armor', 'weapon'] as ModuleSlot[]), tier: this.rng.int(1, 3) };
        }
        this.entities.set(loot.id, loot);
      }
      this.setDestination(pid, { kind: 'point', id: '', name: 'Salvage Cache', pos: cachePos });
      this.events.push({ type: 'log', text: 'Nav coordinates recovered from the wreck. Destination set: salvage cache.', color: '#7fc97f', pid });
      this.events.push({ type: 'comms', pid, text: 'The manifest checks out. Whoever stashed this never came back for it.' });
    } else {
      // it went badly: whatever happened in there collapses the shield
      // outright and tears into the hull on the way out
      e.shield = 0;
      const dmg = e.maxHull * this.rng.range(0.12, 0.22);
      this.applyDamage(e, dmg, -1, true);
      this.events.push({ type: 'log', text: 'Hull breach — you got out, but the ship took a beating escaping the wreck.', color: '#f44', pid });
      this.events.push({ type: 'comms', pid, text: 'You do not talk about what was in the hold. Nobody would believe you anyway.' });
    }
  }

  // -------------------------------------------------------------------------
  // Flight physics
  // -------------------------------------------------------------------------

  private integrateShip(
    e: Entity,
    input: ShipInput,
    perf: { maxSpeed: number; accel: number; turnRate: number },
    dt: number,
    assist: boolean,
  ): void {
    integrateFlight(e, input, perf, dt, assist);
  }

  // -------------------------------------------------------------------------
  // Cruise
  // -------------------------------------------------------------------------

  toggleCruise(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || e.dead || e.dockedAt || meta.docking) return;
    if (e.cruise === 'off') {
      meta.cruiseRequested = true;
      this.tryStartCruise(meta, e);
    } else {
      meta.cruiseRequested = false;
      this.dropCruise(e, 'manual');
    }
  }

  setCruiseRequested(pid: number, on: boolean): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    meta.cruiseRequested = on;
    const e = this.entities.get(pid);
    if (!on && e && e.cruise !== 'off') this.dropCruise(e, 'manual');
  }

  private tryStartCruise(meta: PlayerMeta, e: Entity): void {
    if (e.cruise !== 'off') return;
    if (meta.profile.fuel < 3) {
      this.events.push({ type: 'log', text: 'Cruise drive: insufficient fuel.', color: '#f66', pid: meta.pid });
      meta.cruiseRequested = false;
      return;
    }
    if (this.massSpeedCap(e.pos) < CRUISE_MIN_SPEED) {
      this.events.push({ type: 'log', text: 'Cruise drive: mass-locked. Move clear of the structure first.', color: '#fa4', pid: meta.pid });
      meta.cruiseRequested = false;
      return;
    }
    e.cruise = 'charging';
    e.cruiseSpeed = 0;
    e.lockTimer = 0;
    this.events.push({ type: 'cruiseChange', entityId: e.id, state: 'charging' });
  }

  private tickCruise(meta: PlayerMeta, e: Entity, dt: number): void {
    const prof = meta.profile;
    const stats = meta.stats;
    // gentle steering only
    const steer: ShipInput = {
      ...meta.input,
      pitch: meta.input.pitch * 0.25, yaw: meta.input.yaw * 0.25, roll: meta.input.roll * 0.4,
    };
    const targetAng = v3(steer.pitch * stats.turnRate, steer.yaw * stats.turnRate, steer.roll * stats.turnRate);
    const angAccel = stats.turnRate * 3;
    e.angVel.x += clamp(targetAng.x - e.angVel.x, -angAccel * dt, angAccel * dt);
    e.angVel.y += clamp(targetAng.y - e.angVel.y, -angAccel * dt, angAccel * dt);
    e.angVel.z += clamp(targetAng.z - e.angVel.z, -angAccel * dt, angAccel * dt);
    e.orient = qIntegrate(e.orient, e.angVel, dt);

    // autopilot: with a destination set and hands off the stick, cruise homes
    // toward the marker on its own
    const handsOff = Math.abs(meta.input.pitch) < 0.05 && Math.abs(meta.input.yaw) < 0.05;
    if (meta.destination && handsOff && e.cruise === 'cruise') {
      const want = qLookAt(vnorm(vsub(meta.destination.pos, e.pos)));
      e.orient = rotateTowards(e.orient, want, stats.turnRate * 0.35 * dt);
    }

    if (e.cruise === 'charging') {
      e.cruiseSpeed += dt;
      // keep moving at current velocity while spooling
      vaddTo(e.pos, vscale(e.vel, dt));
      if (e.cruiseSpeed >= CRUISE_CHARGE_S) {
        e.cruise = 'cruise';
        e.cruiseSpeed = Math.max(CRUISE_MIN_SPEED, vlen(e.vel));
        this.events.push({ type: 'cruiseChange', entityId: e.id, state: 'cruise' });
      }
      return;
    }

    // cruise proper: exponential ramp toward a cap set by nearby masses (the
    // "gravity gearbox": deep space = full speed, near a body = crawl). The
    // cap shrinking as you approach gives automatic smooth arrival braking.
    let cap = Math.min(stats.cruiseMax, this.massSpeedCap(e.pos));
    if (meta.destination) {
      const d = vdist(e.pos, meta.destination.pos);
      cap = Math.min(cap, Math.max(CRUISE_DROP_SPEED, d / 4));
      // the mass cap has already braked us; final drop right at the doorstep
      if (d < 2500) {
        this.dropCruise(e, 'arrival');
        this.events.push({ type: 'log', text: `Arriving: ${meta.destination.name}. Destination cleared.`, color: '#8fb', pid: meta.pid });
        meta.destination = null; // GPS resets once you are there
        return;
      }
    }
    e.cruiseSpeed = Math.min(cap, Math.max(CRUISE_DROP_SPEED, e.cruiseSpeed) * Math.pow(2, dt / CRUISE_ACCEL_DOUBLE_S));
    if (cap <= CRUISE_DROP_SPEED * 1.5) {
      this.dropCruise(e, 'masslock');
      this.events.push({ type: 'log', text: 'Mass lock — dropping to maneuver speed.', color: '#fa4', pid: meta.pid });
      return;
    }
    e.vel = vscale(qForward(e.orient), e.cruiseSpeed);
    vaddTo(e.pos, vscale(e.vel, dt));

    const burn = CRUISE_FUEL_PER_S * clamp(e.cruiseSpeed / stats.cruiseMax, 0.15, 1) * dt;
    prof.fuel = Math.max(0, prof.fuel - burn);
    if (prof.fuel <= 0) {
      this.dropCruise(e, 'fuel');
      this.events.push({ type: 'log', text: 'FUEL EXHAUSTED — cruise drive offline.', color: '#f44', pid: meta.pid });
      return;
    }

    // interdiction: rare on empty quiet routes, likely with rich cargo in red space
    if (meta.interdictCooldown <= 0) {
      const danger = dangerAt(this.system, e.pos);
      const cargoRisk = Math.min(0.03, this.cargoValue(prof) / 1e6 * 0.03);
      const p = Math.min(0.06, 0.0015 + danger * 0.018 + cargoRisk) * dt;
      if (this.rng.chance(p)) {
        this.dropCruise(e, 'interdiction');
        meta.interdictCooldown = 90;
        this.events.push({ type: 'interdiction', pid: meta.pid });
        const fwd = qForward(e.orient);
        const n = danger > 0.5 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const tier: PirateTier = danger > 0.7 ? (i === 0 ? 'raider' : 'fighter') : danger > 0.4 ? 'fighter' : 'scout';
          const offset = v3(this.rng.range(-1200, 1200), this.rng.range(-600, 600), this.rng.range(-1200, 1200));
          this.spawnPirate(tier, vadd(vadd(e.pos, vscale(fwd, 2600)), offset), meta.pid);
        }
      }
    }
  }

  private dropCruise(e: Entity, reason: string): void {
    if (e.cruise === 'off') return;
    e.cruise = 'off';
    const sp = Math.min(vlen(e.vel), CRUISE_DROP_SPEED);
    e.vel = vscale(qForward(e.orient), sp);
    e.cruiseSpeed = 0;
    this.events.push({ type: 'cruiseChange', entityId: e.id, state: 'off' });
    const meta = this.players.get(e.id);
    if (meta) meta.cruiseRequested = false;
  }

  // Max cruise speed allowed at a position: distance to the nearest mass edge
  // divided by 3 (so you always have ~3 s of braking room), floored near zero.
  private massSpeedCap(pos: Vec3): number {
    let edge = Infinity;
    edge = Math.min(edge, vlen(pos) - this.system.starRadius * 2.2);
    for (const p of this.system.planets) {
      edge = Math.min(edge, vdist(pos, p.pos) - p.radius * 1.5);
    }
    for (const m of this.system.moons) {
      edge = Math.min(edge, vdist(pos, m.pos) - m.radius * 1.6);
    }
    for (const s of this.system.stations) {
      edge = Math.min(edge, vdist(pos, s.pos) - 1500);
    }
    for (const belt of this.system.belts) {
      for (const f of belt.fields) {
        edge = Math.min(edge, vdist(pos, f.pos) - f.radius * 1.05);
      }
    }
    if (edge <= 0) return 0;
    return Math.max(CRUISE_DROP_SPEED, edge / 3);
  }

  // -------------------------------------------------------------------------
  // Collisions & hazards
  // -------------------------------------------------------------------------

  private tickCollisions(meta: PlayerMeta, e: Entity, dt: number): void {
    // star burn
    const starD = vlen(e.pos);
    if (starD < this.system.starRadius * STAR_BURN_RADIUS_MULT) {
      this.applyDamage(e, 60 * dt, -1, true);
      if (this.tickCount % 20 === 0) {
        this.events.push({ type: 'log', text: 'WARNING: hull temperature critical.', color: '#f44', pid: meta.pid });
      }
    }
    // planets & moons: planetary exclusion field well above the surface —
    // an invisible wall that shoves you back out (no more clipping through)
    meta.forcefieldCooldown = Math.max(0, meta.forcefieldCooldown - dt);
    const bounce = (center: Vec3, shellRadius: number, label: string) => {
      const d = vdist(e.pos, center);
      if (d >= shellRadius) return;
      const n = vnorm(vsub(e.pos, center));
      e.pos = vadd(center, vscale(n, shellRadius + 5));
      // reflect velocity off the shell, heavily damped
      const vn = vdot(e.vel, n);
      if (vn < 0) {
        e.vel = vsub(e.vel, vscale(n, vn * 1.6));
        e.vel = vscale(e.vel, 0.45);
      }
      this.dropCruise(e, 'forcefield');
      if (meta.forcefieldCooldown <= 0) {
        meta.forcefieldCooldown = 3;
        this.events.push({ type: 'forcefield', pid: meta.pid, body: label });
      }
    };
    for (const p of this.system.planets) {
      bounce(p.pos, p.radius * 1.15, p.name);
    }
    for (const m of this.system.moons) {
      bounce(m.pos, m.radius * 1.3, 'moon');
    }
    // stations: bounce
    for (const s of this.system.stations) {
      const d = vdist(e.pos, s.pos);
      if (d < s.radius + e.radius && !e.dockedAt) {
        const n = vnorm(vsub(e.pos, s.pos));
        e.pos = vadd(s.pos, vscale(n, s.radius + e.radius + 2));
        const impact = vlen(e.vel);
        e.vel = vscale(n, Math.max(10, impact * 0.25));
        if (impact > COLLISION_DAMAGE_SPEED) {
          this.applyDamage(e, (impact - COLLISION_DAMAGE_SPEED) * 0.3, -1, true);
        }
      }
    }
    // asteroids (active entities only)
    for (const a of this.entities.values()) {
      if (a.kind !== 'asteroid') continue;
      const d = vdist(e.pos, a.pos);
      if (d < a.radius + e.radius) {
        const n = vnorm(vsub(e.pos, a.pos));
        e.pos = vadd(a.pos, vscale(n, a.radius + e.radius + 1));
        const impact = vlen(e.vel);
        e.vel = vscale(n, Math.max(8, impact * 0.3));
        if (impact > COLLISION_DAMAGE_SPEED) {
          this.applyDamage(e, (impact - COLLISION_DAMAGE_SPEED) * 0.5, -1, true);
        }
      }
    }
    // bulk carriers are solid: half a kilometre of hull is not a suggestion
    for (const n of this.entities.values()) {
      if (n.kind !== 'ship' || n.npc !== 'superfreighter' || n.dead) continue;
      const d = vdist(e.pos, n.pos);
      if (d < n.radius + e.radius) {
        const out = vnorm(vsub(e.pos, n.pos));
        e.pos = vadd(n.pos, vscale(out, n.radius + e.radius + 2));
        const impact = vlen(vsub(e.vel, n.vel));
        e.vel = vadd(vclone(n.vel), vscale(out, Math.max(15, impact * 0.25)));
        if (impact > COLLISION_DAMAGE_SPEED) {
          this.applyDamage(e, (impact - COLLISION_DAMAGE_SPEED) * 0.4, -1, true);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  // Sanitize and apply a remote input frame (server path; offline writes
  // meta.input directly through the IWorld reference).
  setInput(pid: number, input: Partial<ShipInput>): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : 0);
    meta.input.thrustForward = typeof input.thrustForward === 'number' && Number.isFinite(input.thrustForward)
      ? clamp(input.thrustForward, -0.3, 1) : 0;
    meta.input.thrustRight = n(input.thrustRight);
    meta.input.thrustUp = n(input.thrustUp);
    meta.input.pitch = n(input.pitch);
    meta.input.yaw = n(input.yaw);
    meta.input.roll = n(input.roll);
    meta.input.brake = !!input.brake;
    meta.input.turbo = !!input.turbo;
  }

  toggleFlightAssist(pid: number): boolean {
    const meta = this.players.get(pid);
    if (!meta) return true;
    meta.flightAssist = !meta.flightAssist;
    this.events.push({ type: 'log', text: `Flight assist ${meta.flightAssist ? 'ON' : 'OFF'}.`, color: '#8ad', pid });
    return meta.flightAssist;
  }

  setFiring(pid: number, on: boolean): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e) return;
    meta.firing = on;
    e.firing = on;
  }

  setTarget(pid: number, id: number | null): void {
    const e = this.entities.get(pid);
    if (!e) return;
    if (id !== null) {
      const t = this.entities.get(id);
      if (!t || t.dead) return;
    }
    if (e.targetId !== id) {
      e.targetId = id;
      e.lockTimer = 0;
      e.lockedOn = false;
    }
  }

  tabTarget(pid: number): void {
    const e = this.entities.get(pid);
    const meta = this.players.get(pid);
    if (!e || !meta) return;
    // cycle hostile ships by distance
    const hostiles = [...this.entities.values()]
      .filter((t) => t.kind === 'ship' && !t.dead && t.id !== pid && t.pirate !== null
        && vdist(t.pos, e.pos) < meta.stats.sensorRange)
      .sort((a, b) => vdist(a.pos, e.pos) - vdist(b.pos, e.pos));
    if (hostiles.length === 0) {
      this.setTarget(pid, null);
      return;
    }
    const idx = hostiles.findIndex((t) => t.id === e.targetId);
    this.setTarget(pid, hostiles[(idx + 1) % hostiles.length].id);
  }

  // Target whatever is closest to the aim direction within sensor range.
  targetReticle(pid: number): void {
    const e = this.entities.get(pid);
    const meta = this.players.get(pid);
    if (!e || !meta) return;
    const fwd = qForward(e.orient);
    let best: Entity | null = null;
    let bestScore = 0.25; // max angular offset (rad)
    for (const t of this.entities.values()) {
      if (t.id === pid || t.dead) continue;
      if (t.kind !== 'ship' && t.kind !== 'asteroid' && t.kind !== 'loot') continue;
      const d = vdist(t.pos, e.pos);
      if (d > meta.stats.sensorRange) continue;
      const ang = angleBetween(fwd, vsub(t.pos, e.pos));
      if (ang < bestScore) {
        bestScore = ang;
        best = t;
      }
    }
    if (best) this.setTarget(pid, best.id);
  }

  // Weapons fire simulated projectiles: bolts travel, lead matters, strafing
  // dodges. Pirates aim at the intercept point with per-tier error.
  private tickShipCombat(e: Entity, dt: number): void {
    e.weaponCooldown = Math.max(0, e.weaponCooldown - dt);
    if (!e.firing || e.weaponCooldown > 0 || e.dockedAt || e.cruise !== 'off') return;
    const stats = e.isPlayer ? this.players.get(e.id)?.stats : null;
    const pdef = e.pirate ? PIRATES[e.pirate] : null;
    const ndef = e.npc ? NPC_DEFS[e.npc] : null;
    const aidef = pdef ?? (ndef && ndef.shotDamage > 0 ? ndef : null);
    const damage = stats ? stats.weaponDamage : aidef?.shotDamage ?? 0;
    const range = stats ? stats.weaponRange : aidef?.weaponRange ?? 0;
    const interval = stats ? stats.weaponInterval : aidef?.shotInterval ?? 1;
    if (damage <= 0) return;

    let dir: Vec3;
    if (aidef) {
      // AI: lead the target, with per-ship sloppiness
      const target = e.aggroId !== null ? this.entities.get(e.aggroId) : null;
      if (!target || target.dead) return;
      const aim = leadPoint(e.pos, e.vel, target.pos, target.vel, BOLT_SPEED);
      dir = vnorm(vsub(aim, e.pos));
      // turrets swivel freely; hull guns need the nose on target
      if (e.pirate !== 'turret' && angleBetween(qForward(e.orient), dir) > 0.25) return;
      dir = jitterDir(dir, aidef.aimError, this.rng);
    } else {
      if (e.cannonAmmo <= 0) {
        e.weaponCooldown = 0.5;
        return;
      }
      e.cannonAmmo--;
      dir = jitterDir(qForward(e.orient), PLAYER_AIM_SPREAD, this.rng);
    }
    e.weaponCooldown = interval;
    this.spawnBolt(e, dir, damage, range);
    this.events.push({ type: 'shot', entityId: e.id, x: e.pos.x, y: e.pos.y, z: e.pos.z });
  }

  private spawnBolt(from: Entity, dir: Vec3, damage: number, range: number): void {
    const b = blankEntity(this.nextId++, 'bolt');
    b.pos = vadd(from.pos, vscale(dir, from.radius + 6));
    b.vel = vadd(from.vel, vscale(dir, BOLT_SPEED));
    b.orient = qLookAt(dir);
    b.ownerId = from.id;
    b.damage = damage;
    b.ttl = range / BOLT_SPEED;
    b.radius = 1;
    b.name = 'bolt';
    this.entities.set(b.id, b);
  }

  private tickBolt(b: Entity, dt: number): void {
    b.ttl -= dt;
    if (b.ttl <= 0) {
      this.entities.delete(b.id);
      return;
    }
    const prev = vclone(b.pos);
    vaddTo(b.pos, vscale(b.vel, dt));
    // swept collision against ships and rocks along this tick's segment
    for (const t of this.entities.values()) {
      if (t.id === b.ownerId || t.dead) continue;
      if (t.kind !== 'ship' && t.kind !== 'asteroid') continue;
      if (t.kind === 'ship' && t.dockedAt) continue;
      const r = (t.kind === 'asteroid' ? t.radius : t.radius * 1.4) + 1.5;
      if (!segmentHitsSphere(prev, b.pos, t.pos, r)) continue;
      if (t.kind === 'ship') {
        this.applyDamage(t, b.damage * this.rng.range(0.85, 1.15), b.ownerId, false);
      } else {
        // rock soak: a dull spark, no damage
        this.events.push({ type: 'hit', entityId: t.id, shield: false, amount: 0, x: b.pos.x, y: b.pos.y, z: b.pos.z });
      }
      this.entities.delete(b.id);
      return;
    }
  }

  // Missile lock progress for player ships.
  private tickLock(e: Entity, stats: ShipStats, dt: number): void {
    if (stats.missileAmmoMax === 0 || e.missileAmmo <= 0 || e.targetId === null) {
      e.lockTimer = 0;
      e.lockedOn = false;
      return;
    }
    const t = this.entities.get(e.targetId);
    if (!t || t.dead || t.kind !== 'ship' || t.derelict) {
      e.lockTimer = 0;
      e.lockedOn = false;
      return;
    }
    const d = vdist(t.pos, e.pos);
    const ang = angleBetween(qForward(e.orient), vsub(t.pos, e.pos));
    if (d < MISSILE_LOCK_RANGE && ang < MISSILE_LOCK_CONE) {
      if (!e.lockedOn) {
        e.lockTimer += dt;
        if (e.lockTimer >= stats.missileLockTime) {
          e.lockedOn = true;
          if (t.isPlayer) this.events.push({ type: 'lockWarning', pid: t.id });
        }
      }
    } else {
      e.lockTimer = Math.max(0, e.lockTimer - dt * 2);
      e.lockedOn = false;
    }
  }

  fireMissile(pid: number): void {
    const e = this.entities.get(pid);
    const meta = this.players.get(pid);
    if (!e || !meta || e.dead || e.dockedAt || e.cruise !== 'off') return;
    if (!e.lockedOn || e.missileAmmo <= 0 || e.targetId === null) return;
    e.missileAmmo--;
    meta.profile.missileAmmo = e.missileAmmo;
    this.spawnMissile(e, e.targetId, meta.stats.missileDamage);
    e.lockedOn = false;
    e.lockTimer = 0;
  }

  private spawnMissile(from: Entity, targetId: number, damage: number): void {
    const m = blankEntity(this.nextId++, 'missile');
    m.pos = vadd(from.pos, vscale(qForward(from.orient), from.radius + 8));
    m.vel = vadd(from.vel, vscale(qForward(from.orient), 220));
    m.orient = qclone(from.orient);
    m.targetId = targetId;
    m.ownerId = from.id;
    m.damage = damage;
    m.ttl = MISSILE_TTL;
    m.radius = 1.5;
    m.name = 'missile';
    this.entities.set(m.id, m);
  }

  private tickMissile(m: Entity, dt: number): void {
    m.ttl -= dt;
    if (m.ttl <= 0) {
      this.entities.delete(m.id);
      return;
    }
    const target = m.targetId !== null ? this.entities.get(m.targetId) : null;
    if (target && !target.dead) {
      // steer toward target, capped turn rate
      const desired = vnorm(vsub(target.pos, m.pos));
      const cur = vnorm(m.vel);
      const ang = angleBetween(cur, desired);
      const maxTurn = MISSILE_TURN * dt;
      let dir: Vec3;
      if (ang < maxTurn || ang < 1e-4) {
        dir = desired;
      } else {
        const t = maxTurn / ang;
        dir = vnorm(vlerpDir(cur, desired, t));
      }
      m.vel = vscale(dir, Math.min(MISSILE_SPEED, vlen(m.vel) + 500 * dt));
      m.orient = qLookAt(dir);
      const d = vdist(m.pos, target.pos);
      if (d < target.radius + 45) {
        this.applyDamage(target, m.damage, m.ownerId, false);
        this.events.push({ type: 'explosion', entityId: m.id, big: false, x: m.pos.x, y: m.pos.y, z: m.pos.z });
        this.entities.delete(m.id);
        return;
      }
    } else {
      m.vel = vscale(vnorm(m.vel), Math.min(MISSILE_SPEED, vlen(m.vel) + 500 * dt));
    }
    vaddTo(m.pos, vscale(m.vel, dt));
  }

  // Apply damage with all protection rules. sourceId -1 = environment.
  applyDamage(target: Entity, amount: number, sourceId: number, environmental: boolean): void {
    if (target.dead || target.dockedAt) return;
    if (target.derelict && !environmental) return; // hulks just soak fire
    const meta = target.isPlayer ? this.players.get(target.id) : undefined;
    if (meta && (meta.undockInvuln > 0 || meta.docking || meta.rescueTimer > 0)) return;

    if (!environmental && sourceId >= 0) {
      const source = this.entities.get(sourceId);
      // PvP only outside policed space
      if (source?.isPlayer && target.isPlayer) {
        if (dangerAt(this.system, target.pos) < 0.3) return;
      }
      // pirate aggro: fight back (only against player attackers — pirate
      // friendly fire must not start internal wars)
      if (target.pirate && source?.isPlayer) {
        target.aggroId = sourceId;
        if (target.aiState === 'patrol' || target.aiState === 'approach') target.aiState = 'attack';
      }
      // interrupt cruise charge
      if (target.cruise === 'charging') {
        this.dropCruise(target, 'damage');
        if (meta) this.events.push({ type: 'log', text: 'Cruise charge interrupted by weapons fire!', color: '#f66', pid: target.id });
      }
      // ambient traffic reacts: civilians flee + scream, patrols answer
      if (target.npc) this.traffic.onNpcDamaged(target, sourceId);
    }

    target.shieldRegenTimer = 0;
    if (target.isPlayer && !environmental) {
      const tmeta = this.players.get(target.id);
      if (tmeta) tmeta.lastCombatAt = this.time;
    }
    // attacker position rides along for the HUD damage-direction arrows
    const src = !environmental && sourceId >= 0 ? this.entities.get(sourceId) : undefined;
    const from = src ? { fx: src.pos.x, fy: src.pos.y, fz: src.pos.z } : {};
    let remaining = amount;
    if (target.shield > 0) {
      const absorbed = Math.min(target.shield, remaining);
      target.shield -= absorbed;
      remaining -= absorbed;
      this.events.push({ type: 'hit', entityId: target.id, shield: true, amount: Math.round(absorbed), x: target.pos.x, y: target.pos.y, z: target.pos.z, ...from });
    }
    if (remaining > 0) {
      target.hull -= remaining;
      this.events.push({ type: 'hit', entityId: target.id, shield: false, amount: Math.round(remaining), x: target.pos.x, y: target.pos.y, z: target.pos.z, ...from });
      if (target.hull <= 0) this.handleDeath(target, sourceId);
    }
  }

  private handleDeath(e: Entity, killerId: number): void {
    e.hull = 0;
    this.events.push({ type: 'explosion', entityId: e.id, big: true, x: e.pos.x, y: e.pos.y, z: e.pos.z });

    if (e.pirate) {
      this.traffic.onPirateKilled(e.id, killerId);
      this.dropPirateLoot(e);
      // a dying carrier takes its remaining turrets with it
      if (e.pirate === 'corvette') {
        for (const t of [...this.entities.values()]) {
          if (t.parentId === e.id) {
            this.events.push({ type: 'explosion', entityId: t.id, big: false, x: t.pos.x, y: t.pos.y, z: t.pos.z });
            this.entities.delete(t.id);
          }
        }
      }
      const killer = this.entities.get(killerId);
      if (killer?.isPlayer) {
        const kmeta = this.players.get(killerId)!;
        kmeta.profile.stats.kills++;
        // bounty contract progress (turrets are parts, not kills)
        for (const c of kmeta.profile.contracts) {
          if (e.pirate === 'turret') break;
          if (c.type !== 'bounty' || c.killsDone >= c.killsRequired || !c.pirateZone) continue;
          const zone = this.fieldById(c.pirateZone);
          if (zone && vdist(e.pos, zone.pos) < 45_000) {
            c.killsDone++;
            if (c.killsDone >= c.killsRequired) {
              this.completeContract(kmeta, c);
            } else {
              this.events.push({ type: 'log', text: `Bounty progress: ${c.killsDone}/${c.killsRequired}.`, color: '#fc6', pid: killerId });
            }
          }
        }
        // standing with the locals
        this.addRep(kmeta.profile, 'scrappers', -1);
        const nearest = this.nearestStation(e.pos);
        if (!nearest.blackMarket) this.addRep(kmeta.profile, nearest.factionId, e.pirate === 'scout' ? 0.5 : 1);
      }
      this.entities.delete(e.id);
      return;
    }

    if (e.npc) {
      // civilian wrecks shed a little of their cargo
      if (e.npc !== 'patrol' && e.goodId && this.rng.chance(0.8)) {
        const loot = blankEntity(this.nextId++, 'loot');
        loot.pos = vclone(e.pos);
        loot.vel = vscale(e.vel, 0.05);
        loot.ttl = 240;
        loot.radius = 4;
        loot.name = 'cargo spill';
        loot.goodId = e.goodId;
        loot.qty = this.rng.int(3, 8);
        loot.lootCredits = this.rng.int(20, 120);
        this.entities.set(loot.id, loot);
      }
      this.traffic.onNpcKilled(e, killerId);
      this.entities.delete(e.id);
      return;
    }

    if (e.isPlayer) {
      const meta = this.players.get(e.id)!;
      const prof = meta.profile;
      const lostCargo = prof.cargo.reduce((s, c) => s + c.qty, 0);
      // contract cargo gone: fail those contracts now
      for (const c of [...prof.contracts]) {
        if ((c.type === 'transport' || c.type === 'urgent') && prof.cargo.some((ci) => ci.contractId === c.id)) {
          this.failContract(meta, c, 'cargo destroyed');
        }
      }
      prof.cargo = [];
      const deductible = Math.min(prof.credits, Math.round(shipValue(prof.hullId, prof.modules) * INSURANCE_DEDUCTIBLE));
      prof.credits -= deductible;
      prof.stats.deaths++;
      // insurance recovers the ship at the respawn station
      const st = this.station(prof.respawnStation) ?? this.system.stations[0];
      e.dead = false;
      e.hull = meta.stats.maxHull;
      e.shield = meta.stats.maxShield;
      e.vel = v3();
      e.angVel = v3();
      e.cruise = 'off';
      e.cruiseSpeed = 0;
      e.targetId = null;
      e.lockedOn = false;
      e.lockTimer = 0;
      prof.fuel = meta.stats.fuelMax;
      meta.drillOn = false;
      meta.firing = false;
      e.firing = false;
      meta.destination = null;
      meta.docking = null;
      meta.cruiseRequested = false;
      e.dockedAt = st.id;
      e.pos = vclone(st.pos);
      this.events.push({ type: 'death', pid: e.id, lostCargo, deductible });
      return;
    }
  }

  private dropPirateLoot(e: Entity): void {
    const def = PIRATES[e.pirate!];
    const loot = blankEntity(this.nextId++, 'loot');
    loot.pos = vclone(e.pos);
    loot.vel = vscale(e.vel, 0.2);
    loot.ttl = LOOT_TTL;
    loot.radius = 4;
    loot.name = 'salvage';
    loot.lootCredits = this.rng.int(def.creditsMin, def.creditsMax);
    const drop = this.rng.pickWeighted(PIRATE_GOOD_DROPS, PIRATE_GOOD_DROPS.map((d) => d.weight));
    loot.goodId = drop.good;
    loot.qty = this.rng.int(drop.min, drop.max);
    if (this.rng.chance(def.moduleChance)) {
      const slots: ModuleSlot[] = ['engine', 'gyro', 'shield', 'armor', 'weapon', 'scanner', 'collector'];
      loot.lootModule = { slot: this.rng.pick(slots), tier: this.rng.int(1, def.moduleTierMax) };
    }
    this.entities.set(loot.id, loot);
  }

  // -------------------------------------------------------------------------
  // Pirates
  // -------------------------------------------------------------------------

  spawnPirate(tier: PirateTier, pos: Vec3, aggroPid: number | null = null): Entity {
    const def = PIRATES[tier];
    const e = blankEntity(this.nextId++, 'ship');
    e.pirate = tier;
    e.name = def.name;
    e.factionId = 'scrappers';
    e.hullId = 'pirate';
    e.radius = SHIP_RADIUS.pirate * (tier === 'corvette' ? 4 : tier === 'elite' ? 1.6 : tier === 'raider' ? 1.3 : tier === 'turret' ? 0.5 : 1);
    e.maxHull = def.hull;
    e.hull = def.hull;
    e.maxShield = def.shield;
    e.shield = def.shield;
    e.missileAmmo = def.missiles;
    e.pos = vclone(pos);
    e.spawnPos = vclone(pos);
    e.aiState = aggroPid !== null ? 'attack' : 'patrol';
    e.aggroId = aggroPid;
    e.aiTimer = 0;
    this.entities.set(e.id, e);
    if (aggroPid !== null) this.events.push({ type: 'hostileDetected', pid: aggroPid });
    return e;
  }

  // Mini-boss: an Ironclad gun platform with four destructible autocannon
  // turrets riding on its hull. Kill the guns, then grind the shield down.
  spawnCorvette(pos: Vec3, aggroPid: number | null = null): Entity {
    const corvette = this.spawnPirate('corvette', pos, aggroPid);
    const offsets = [v3(22, 9, -18), v3(-22, 9, -18), v3(22, -9, 20), v3(-22, -9, 20)];
    for (const off of offsets) {
      const turret = this.spawnPirate('turret', vadd(pos, off));
      turret.parentId = corvette.id;
      turret.spawnPos = vclone(off); // local mount offset on the carrier
    }
    return corvette;
  }

  // Spawn a derelict wreck site a few km off the player's path: either loose
  // salvage containers (sometimes pirate bait) or a dead ship with a story —
  // breach its hold for coordinates to a cache… or for something worse.
  private maybeSpawnWreck(meta: PlayerMeta, e: Entity): boolean {
    // deep space only: no station within 60 km, not inside a field
    for (const st of this.system.stations) {
      if (vdist(e.pos, st.pos) < 60_000) return false;
    }
    if (e.cruise === 'cruise') return false; // you blow past it at cruise speed
    const dir = vnorm(v3(this.rng.range(-1, 1), this.rng.range(-0.3, 0.3), this.rng.range(-1, 1)));
    const sitePos = vadd(e.pos, vscale(dir, this.rng.range(3000, 6000)));

    if (this.rng.chance(0.5)) {
      // story derelict: an inert hulk, prompts when you fly close
      const hulk = blankEntity(this.nextId++, 'ship');
      hulk.derelict = true;
      hulk.name = `Derelict — "${this.rng.pick(DERELICT_NAMES)}"`;
      hulk.hullId = this.rng.chance(0.6) ? 'hauler' : 'shuttle';
      hulk.radius = SHIP_RADIUS[hulk.hullId] * 1.2;
      hulk.maxHull = 400;
      hulk.hull = 400;
      hulk.pos = vclone(sitePos);
      hulk.vel = v3(this.rng.range(-1.5, 1.5), this.rng.range(-1, 1), this.rng.range(-1.5, 1.5));
      hulk.orient = qLookAt(vnorm(v3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1))));
      hulk.ttl = 1200;
      this.entities.set(hulk.id, hulk);
      this.events.push({
        type: 'comms', pid: meta.pid,
        text: 'A dead transponder pings once, then nothing. There is a hull out there, running cold.',
      });
      this.events.push({ type: 'log', text: 'Cold hull detected — derelict signature marked on scanner.', color: '#7fb1c9', pid: meta.pid });
      return true;
    }
    const containers = this.rng.int(2, 3);
    for (let i = 0; i < containers; i++) {
      const loot = blankEntity(this.nextId++, 'loot');
      loot.pos = vadd(sitePos, v3(this.rng.range(-220, 220), this.rng.range(-120, 120), this.rng.range(-220, 220)));
      loot.vel = v3(this.rng.range(-2, 2), this.rng.range(-1, 1), this.rng.range(-2, 2));
      loot.ttl = 600;
      loot.radius = 4;
      loot.name = 'wreckage';
      loot.lootCredits = this.rng.int(40, 260);
      const drop = this.rng.pickWeighted(PIRATE_GOOD_DROPS, PIRATE_GOOD_DROPS.map((d) => d.weight));
      loot.goodId = drop.good;
      loot.qty = this.rng.int(drop.min, drop.max);
      if (this.rng.chance(0.06)) {
        loot.lootModule = { slot: this.rng.pick(['shield', 'scanner', 'collector', 'armor'] as ModuleSlot[]), tier: this.rng.int(1, 3) };
      }
      this.entities.set(loot.id, loot);
    }
    // bait: lurking pirates wake when you come close (they patrol the site)
    if (this.rng.chance(0.35)) {
      const n = this.rng.int(1, 2);
      for (let i = 0; i < n; i++) {
        this.spawnPirate(this.rollPirateTier(Math.max(0.3, dangerAt(this.system, sitePos))),
          vadd(sitePos, v3(this.rng.range(-1500, 1500), this.rng.range(-400, 400), this.rng.range(-1500, 1500))));
      }
    }
    this.events.push({
      type: 'comms', pid: meta.pid,
      text: this.rng.pick([
        'Automated distress beacon, repeating. No flight plan on record. Source: close.',
        '…hull breach… all hands… (the rest is static). The beacon is still transmitting, nearby.',
        'A weak salvage transponder pings on your scanner. Somebody had a worse day than you.',
      ]),
    });
    this.events.push({ type: 'log', text: 'Distress beacon detected — salvage signature marked on scanner.', color: '#7fb1c9', pid: meta.pid });
    return true;
  }

  private maybeSpawnPirates(meta: PlayerMeta, e: Entity): void {
    const danger = dangerAt(this.system, e.pos);
    if (danger < 0.055) return;
    for (const st of this.system.stations) {
      if (!st.blackMarket && vdist(e.pos, st.pos) < st.safeRadius) return;
    }
    // count pirates already harassing this player area (turrets are parts)
    let nearby = 0;
    let corvetteNear = false;
    for (const p of this.entities.values()) {
      if (p.kind !== 'ship' || !p.pirate || p.pirate === 'turret') continue;
      const d = vdist(p.pos, e.pos);
      if (p.pirate === 'corvette' && d < 30_000) corvetteNear = true;
      if (d < 15_000) nearby += p.pirate === 'elite' || p.pirate === 'corvette' ? 2 : 1;
    }
    const cap = danger < 0.3 ? 2 : danger < 0.6 ? 3 : 4;
    if (nearby >= cap) return;
    if (!this.rng.chance(Math.min(0.5, danger * 0.55))) return;

    // deep red space occasionally fields an Ironclad gun platform
    if (danger > 0.55 && !corvetteNear && this.rng.chance(0.16)) {
      const dir = vnorm(v3(this.rng.range(-1, 1), this.rng.range(-0.2, 0.2), this.rng.range(-1, 1)));
      this.spawnCorvette(vadd(e.pos, vscale(dir, this.rng.range(5500, 7500))));
      return;
    }

    const groupSize = danger > 0.6 ? this.rng.int(2, 3) : this.rng.int(1, 2);
    for (let i = 0; i < groupSize && nearby < cap; i++) {
      const tier = this.rollPirateTier(danger);
      const dir = vnorm(v3(this.rng.range(-1, 1), this.rng.range(-0.3, 0.3), this.rng.range(-1, 1)));
      const distAway = this.rng.range(4500, 7000);
      this.spawnPirate(tier, vadd(e.pos, vscale(dir, distAway)));
      nearby += tier === 'elite' ? 2 : 1;
    }
  }

  private rollPirateTier(danger: number): PirateTier {
    const tiers: PirateTier[] = ['scout', 'fighter', 'raider', 'elite'];
    if (danger < 0.25) return this.rng.pickWeighted(tiers, [7, 3, 0, 0]);
    if (danger < 0.5) return this.rng.pickWeighted(tiers, [2.5, 5.5, 2, 0]);
    if (danger < 0.75) return this.rng.pickWeighted(tiers, [0, 4, 4.5, 1.5]);
    return this.rng.pickWeighted(tiers, [0, 2, 5, 3]);
  }

  private tickPirate(e: Entity, dt: number): void {
    if (!e.pirate || e.dead) return;
    const def = PIRATES[e.pirate];
    e.aiTimer -= dt;

    // turrets ride their carrier and swivel freely at whatever it hates
    if (e.pirate === 'turret') {
      const parent = e.parentId ? this.entities.get(e.parentId) : undefined;
      if (!parent || parent.dead) {
        // carrier gone: dead weight
        this.events.push({ type: 'explosion', entityId: e.id, big: false, x: e.pos.x, y: e.pos.y, z: e.pos.z });
        this.entities.delete(e.id);
        return;
      }
      e.pos = vadd(parent.pos, qrot(parent.orient, e.spawnPos));
      e.vel = vclone(parent.vel);
      e.orient = parent.orient;
      const target = parent.aggroId !== null ? this.entities.get(parent.aggroId) : null;
      if (target && !target.dead && !target.dockedAt && vdist(target.pos, e.pos) < def.weaponRange) {
        e.aggroId = target.id;
        e.firing = true;
      } else {
        e.aggroId = null;
        e.firing = false;
      }
      return;
    }

    // despawn when far from every player
    let nearestPlayer: Entity | null = null;
    let nearestD = Infinity;
    for (const meta of this.players.values()) {
      const p = this.entities.get(meta.pid);
      if (!p || p.dead || p.dockedAt) continue;
      const d = vdist(p.pos, e.pos);
      if (d < nearestD) {
        nearestD = d;
        nearestPlayer = p;
      }
    }
    if (nearestD > PIRATE_DESPAWN_RANGE) {
      this.entities.delete(e.id);
      return;
    }

    // keep out of police zones
    for (const st of this.system.stations) {
      if (st.blackMarket) continue;
      const d = vdist(e.pos, st.pos);
      if (d < st.safeRadius * 1.15 && e.aiState !== 'flee') {
        e.aiState = 'flee';
        e.aggroId = null;
        e.aiTimer = 8;
      }
    }

    const target = e.aggroId !== null ? this.entities.get(e.aggroId) : null;
    const targetGone = !target || target.dead || target.dockedAt
      || (target.isPlayer && (this.players.get(target.id)?.rescueTimer ?? 0) > 0)
      || vdist(target.pos, e.pos) > def.detectRange * 2.5
      || target.cruise === 'cruise';

    switch (e.aiState) {
      case 'patrol': {
        // lazy loop around the spawn point; scan for prey
        const t = this.time * 0.07 + e.id * 1.7;
        const wander = vadd(e.spawnPos, v3(Math.sin(t) * 2600, Math.sin(t * 0.6) * 700, Math.cos(t) * 2600));
        e.targetId = null;
        this.steerToward(e, wander, def, 0.4, dt);
        if (nearestPlayer && nearestD < def.detectRange && nearestPlayer.cruise !== 'cruise') {
          e.aggroId = nearestPlayer.id;
          e.aiState = 'approach';
          this.events.push({ type: 'hostileDetected', pid: nearestPlayer.id });
        } else {
          // no player in reach? civilian traffic will do (never the police,
          // never the bulk carriers — too big to crack)
          for (const civ of this.entities.values()) {
            if (civ.kind !== 'ship' || !civ.npc || civ.dead) continue;
            if (civ.npc === 'patrol' || civ.npc === 'superfreighter') continue;
            if (vdist(civ.pos, e.pos) < def.detectRange * 0.8) {
              e.aggroId = civ.id;
              e.aiState = 'approach';
              break;
            }
          }
        }
        break;
      }
      case 'approach': {
        if (targetGone) {
          e.aiState = 'patrol';
          e.aggroId = null;
          break;
        }
        this.steerToward(e, target!.pos, def, 1, dt);
        if (vdist(target!.pos, e.pos) < def.weaponRange * 0.85) {
          e.aiState = 'attack';
          e.aiPhase = 0;
          e.aiTimer = 8; // reposition budget
        }
        break;
      }
      case 'attack': {
        if (targetGone) {
          e.aiState = 'patrol';
          e.aggroId = null;
          e.firing = false;
          break;
        }
        const d = vdist(target!.pos, e.pos);
        e.targetId = target!.id;
        e.missileCooldown = Math.max(0, e.missileCooldown - dt);

        if (e.pirate === 'corvette') {
          // the Ironclad just bears down and lets the turrets work
          this.steerToward(e, target!.pos, def, d > 900 ? 1 : 0.3, dt);
          const angC = angleBetween(qForward(e.orient), vsub(target!.pos, e.pos));
          e.firing = d < def.weaponRange && angC < 0.2;
        } else {
          // dogfight phases: chase the six -> attack run -> break off
          const jink = v3(
            Math.sin(this.time * 1.7 + e.id) * 90,
            Math.sin(this.time * 1.3 + e.id * 2.3) * 50,
            Math.cos(this.time * 1.5 + e.id) * 90,
          );
          switch (e.aiPhase) {
            case 0: { // reposition: work toward the target's tail
              const tFwd = qForward(target!.orient);
              const tail = vadd(vadd(target!.pos, vscale(tFwd, -340)), jink);
              this.steerToward(e, tail, def, 1, dt);
              // opportunistic snapshots while closing
              const aim = leadPoint(e.pos, e.vel, target!.pos, target!.vel, BOLT_SPEED);
              const ang0 = angleBetween(qForward(e.orient), vsub(aim, e.pos));
              e.firing = d < def.weaponRange * 0.9 && ang0 < 0.08;
              const behind = vdot(tFwd, vnorm(vsub(e.pos, target!.pos))) < -0.25;
              if ((behind && d < def.weaponRange) || e.aiTimer <= 0) {
                e.aiPhase = 1;
                e.aiTimer = this.rng.range(3, 5);
              }
              break;
            }
            case 1: { // attack run: nose on the intercept point, guns hot
              const aim = vadd(leadPoint(e.pos, e.vel, target!.pos, target!.vel, BOLT_SPEED), vscale(jink, 0.3));
              const throttle = d > 650 ? 0.9 : d < 280 ? 0.15 : 0.5;
              this.steerToward(e, aim, def, throttle, dt);
              const ang1 = angleBetween(qForward(e.orient), vsub(aim, e.pos));
              e.firing = d < def.weaponRange && ang1 < 0.14;
              if (d < 210 || e.aiTimer <= 0) {
                e.aiPhase = 2;
                e.aiTimer = this.rng.range(1.6, 2.6);
                e.firing = false;
              }
              break;
            }
            default: { // break off: peel away hard, then come back around
              const side = qrot(e.orient, v3(e.id % 2 === 0 ? 1 : -1, e.id % 3 === 0 ? 0.5 : -0.3, 0));
              const breakPoint = vadd(e.pos, vadd(vscale(vnorm(side), 900), vscale(qForward(e.orient), 480)));
              this.steerToward(e, breakPoint, def, 1, dt);
              e.firing = false;
              if (e.aiTimer <= 0) {
                e.aiPhase = 0;
                e.aiTimer = 8;
              }
              break;
            }
          }
        }
        // missiles for heavies — warlords launch a volley
        const angM = angleBetween(qForward(e.orient), vsub(target!.pos, e.pos));
        if (def.missiles > 0 && e.missileAmmo > 0 && e.missileCooldown <= 0 && d < 2500 && angM < 0.3) {
          e.missileCooldown = this.rng.range(16, 26);
          const volley = e.pirate === 'elite' ? Math.min(2, e.missileAmmo) : 1;
          for (let v = 0; v < volley; v++) {
            e.missileAmmo--;
            this.spawnMissile(e, target!.id, def.missileDamage);
          }
          if (target!.isPlayer) this.events.push({ type: 'lockWarning', pid: target!.id });
        }
        if (e.hull < e.maxHull * 0.22 && e.pirate !== 'corvette') {
          e.aiState = 'flee'; // the Ironclad never runs
          e.firing = false;
          e.aiTimer = 30;
        }
        break;
      }
      case 'flee': {
        e.firing = false;
        const away = target ? vnorm(vsub(e.pos, target.pos)) : vnorm(vsub(e.pos, e.spawnPos));
        this.steerToward(e, vadd(e.pos, vscale(away, 5000)), def, 1, dt);
        if (e.aiTimer <= 0 || nearestD > 14_000) {
          this.entities.delete(e.id); // slinks back into the void
          return;
        }
        break;
      }
    }
    vaddTo(e.pos, vscale(e.vel, dt));
  }

  // Steer an AI ship: rotate nose toward a point, throttle along it.
  private steerToward(e: Entity, point: Vec3, def: { maxSpeed: number; accel: number; turnRate: number }, throttle: number, dt: number): void {
    const desired = qLookAt(vnorm(vsub(point, e.pos)));
    e.orient = rotateTowards(e.orient, desired, def.turnRate * dt);
    const fwd = qForward(e.orient);
    const want = vscale(fwd, def.maxSpeed * clamp(throttle, -0.3, 1));
    const delta = vsub(want, e.vel);
    const dl = vlen(delta);
    if (dl > 1e-6) vaddTo(e.vel, vscale(delta, Math.min(1, (def.accel * dt) / dl)));
  }

  private tickStationTurrets(): void {
    for (const st of this.system.stations) {
      if (st.blackMarket) continue;
      for (const e of this.entities.values()) {
        if (e.kind === 'ship' && e.pirate && !e.dead && vdist(e.pos, st.pos) < st.safeRadius) {
          this.applyDamage(e, STATION_TURRET_DPS, -1, true);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Asteroid fields & mining
  // -------------------------------------------------------------------------

  private updateFieldActivation(): void {
    if (this.tickCount % 20 !== 0) return; // once a second
    const wanted = new Set<string>();
    for (const meta of this.players.values()) {
      const e = this.entities.get(meta.pid);
      if (!e || e.dockedAt) continue;
      for (const belt of this.system.belts) {
        for (const f of belt.fields) {
          if (vdist(e.pos, f.pos) < f.radius + FIELD_ACTIVATE_MARGIN) wanted.add(f.id);
        }
      }
    }
    // activate new fields
    for (const fid of wanted) {
      if (this.activeFields.has(fid)) continue;
      this.activeFields.add(fid);
      this.activateField(fid);
    }
    // deactivate stale fields
    for (const fid of [...this.activeFields]) {
      if (wanted.has(fid)) continue;
      this.activeFields.delete(fid);
      for (const e of [...this.entities.values()]) {
        if (e.kind === 'asteroid' && e.fieldId === fid) {
          const key = `${fid}:${e.rockIndex}`;
          const st = this.rocks.get(key);
          if (st) st.entityId = null;
          this.entities.delete(e.id);
        }
      }
    }
    // respawn destroyed rocks whose timer elapsed
    for (const [key, st] of this.rocks) {
      if (st.hp <= 0 && st.respawnAt > 0 && this.time >= st.respawnAt) {
        this.rocks.delete(key); // fresh state regenerates on next activation
        const fid = key.slice(0, key.lastIndexOf(':'));
        if (this.activeFields.has(fid)) {
          this.activeFields.delete(fid); // force re-activation next pass
        }
      }
    }
  }

  private activateField(fieldId: string): void {
    const field = this.fieldById(fieldId);
    if (!field) return;
    const belt = this.system.belts.find((b) => b.id === field.beltId)!;
    for (let i = 0; i < field.rockCount; i++) {
      const key = `${fieldId}:${i}`;
      let st = this.rocks.get(key);
      const spawn = rockSpawn(field, belt, i);
      if (!st) {
        const def = ROCK_TYPES[spawn.type];
        const total = spawn.radius * def.yieldPerRadius;
        const yieldLeft: Record<string, number> = {};
        let wsum = 0;
        for (const y of def.yields) wsum += y.weight;
        for (const y of def.yields) yieldLeft[y.good] = Math.round(total * (y.weight / wsum));
        st = { hp: spawn.radius * def.hpPerRadius, yieldLeft, respawnAt: 0, entityId: null };
        this.rocks.set(key, st);
      }
      if (st.hp <= 0 || st.entityId !== null) continue;
      const e = blankEntity(this.nextId++, 'asteroid');
      e.pos = vclone(spawn.pos);
      e.radius = spawn.radius;
      e.rockType = spawn.type;
      e.rockHp = st.hp;
      e.rockMaxHp = spawn.radius * ROCK_TYPES[spawn.type].hpPerRadius;
      e.rockYield = st.yieldLeft;
      e.hotspots = spawn.hotspots;
      e.fieldId = fieldId;
      e.rockIndex = i;
      e.name = `${spawn.type} asteroid`;
      st.entityId = e.id;
      this.entities.set(e.id, e);
    }
  }

  setDrill(pid: number, on: boolean): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    if (on && meta.stats.drillRate === 0) {
      this.events.push({ type: 'log', text: 'No mining drill installed.', color: '#f66', pid });
      return;
    }
    meta.drillOn = on;
    if (!on) meta.miningBeam = false;
  }

  // The mining beam: hold RMB with the drill deployed. Heat builds while
  // firing and the drill locks out when it redlines — no AFK strip-mining.
  // Most pulls are worthless regolith; carving the glowing seams (hotspots)
  // is where the real ore comes from.
  setMiningBeam(pid: number, on: boolean): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    meta.miningBeam = on && meta.drillOn;
  }

  private tickMining(meta: PlayerMeta, e: Entity, dt: number): void {
    if (meta.stats.drillRate === 0) return;
    const firing = meta.drillOn && meta.miningBeam && !meta.drillOverheated && e.cruise === 'off' && !e.dockedAt;
    meta.beamFiring = firing;
    // beam FX cadence: every 2nd tick (10 Hz) is enough for a continuous
    // look client-side and halves the event traffic in online snapshots
    const emitBeam = firing && this.tickCount % 2 === 0;

    // heat model: builds while the beam is on, cools whenever it is not
    if (firing) {
      meta.drillHeat = Math.min(1, meta.drillHeat + DRILL_HEAT_PER_S * dt);
      if (meta.drillHeat >= 1) {
        meta.drillOverheated = true;
        this.events.push({ type: 'log', text: 'DRILL OVERHEAT — venting. Ease off the trigger, pilot.', color: '#f66', pid: meta.pid });
        return;
      }
    } else {
      meta.drillHeat = Math.max(0, meta.drillHeat - DRILL_COOL_PER_S * dt);
      if (meta.drillOverheated && meta.drillHeat <= DRILL_OVERHEAT_RESUME) {
        meta.drillOverheated = false;
        this.events.push({ type: 'log', text: 'Drill back within thermal limits.', color: '#8fb', pid: meta.pid });
      }
      return;
    }

    // tight aimed beam: whatever rock sits under the reticle
    const fwd = qForward(e.orient);
    let rock: Entity | null = null;
    let best = 0.15;
    for (const t of this.entities.values()) {
      if (t.kind !== 'asteroid') continue;
      const d = vdist(t.pos, e.pos);
      if (d > meta.stats.drillRange) continue;
      const ang = angleBetween(fwd, vsub(t.pos, e.pos));
      const cone = Math.max(0.06, Math.atan(t.radius / Math.max(d, 1)) * 0.9);
      if (ang < Math.min(best, cone)) {
        best = ang;
        rock = t;
      }
    }
    if (!rock) {
      // beam into the void: visual only
      if (emitBeam) {
        const end = vadd(e.pos, vscale(fwd, meta.stats.drillRange * 0.8));
        this.events.push({ type: 'laser', fromId: e.id, toX: end.x, toY: end.y, toZ: end.z, hit: false, mining: true });
      }
      return;
    }

    const key = `${rock.fieldId}:${rock.rockIndex}`;
    const st = this.rocks.get(key);
    if (!st || st.hp <= 0) return;
    const rate = meta.stats.drillRate * MINING_RATE_FACTOR;
    st.hp -= rate * dt * (ROCK_TYPES[rock.rockType!].hpPerRadius / 1.5);
    rock.rockHp = Math.max(0, st.hp);
    meta.extractAcc += rate * dt;
    if (emitBeam) {
      this.events.push({ type: 'laser', fromId: e.id, toX: rock.pos.x, toY: rock.pos.y, toZ: rock.pos.z, hit: true, mining: true });
    }

    // are we carving a hotspot seam? (beam impact point vs seam axes)
    let onSeam = false;
    if (rock.hotspots) {
      const impactDir = vnorm(vsub(e.pos, rock.pos)); // facing side of the rock
      for (const h of rock.hotspots) {
        if (angleBetween(impactDir, h) < HOTSPOT_CONE) {
          onSeam = true;
          break;
        }
      }
    }

    while (meta.extractAcc >= FRAGMENT_CHUNK) {
      meta.extractAcc -= FRAGMENT_CHUNK;
      this.spawnFragment(rock, st, e.pos, onSeam);
    }
    if (st.hp <= 0) {
      st.respawnAt = this.time + ASTEROID_RESPAWN_S;
      st.entityId = null;
      this.events.push({ type: 'explosion', entityId: rock.id, big: false, x: rock.pos.x, y: rock.pos.y, z: rock.pos.z });
      // cracking the rock open always sheds something real
      for (let i = 0; i < 2; i++) this.spawnFragment(rock, st, e.pos, true);
      this.entities.delete(rock.id);
    }
  }

  private spawnFragment(rock: Entity, st: RockState, towards: Vec3, onSeam: boolean): void {
    // grindy by design: most pulls are regolith; the real composition only
    // comes out at base odds — or much better odds while carving a seam
    const oreChance = onSeam ? ORE_CHANCE_HOTSPOT : ORE_CHANCE_BASE;
    let good: string;
    let qty: number;
    const goods = Object.keys(st.yieldLeft).filter((g) => st.yieldLeft[g] > 0);
    if (goods.length > 0 && this.rng.chance(oreChance)) {
      const weights = goods.map((g) => st.yieldLeft[g]);
      good = this.rng.pickWeighted(goods, weights);
      qty = Math.min(st.yieldLeft[good], FRAGMENT_CHUNK);
      st.yieldLeft[good] -= qty;
    } else {
      good = 'stone';
      qty = this.rng.int(1, FRAGMENT_CHUNK);
    }
    const f = blankEntity(this.nextId++, 'fragment');
    // bias the debris toward the mining ship so the collector has work to do
    const rand = vnorm(v3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)));
    const toMiner = vnorm(vsub(towards, rock.pos));
    const dir = vnorm(vadd(vscale(toMiner, 0.65), vscale(rand, 0.35)));
    f.pos = vadd(rock.pos, vscale(dir, rock.radius * 0.8));
    f.vel = vscale(dir, this.rng.range(8, 20));
    f.goodId = good;
    f.qty = qty;
    f.ttl = FRAGMENT_TTL;
    f.radius = 2;
    f.name = GOODS[good].name;
    this.entities.set(f.id, f);
    this.events.push({ type: 'fragment', entityId: f.id, x: f.pos.x, y: f.pos.y, z: f.pos.z });
  }

  private tickFloating(e: Entity, dt: number): void {
    e.ttl -= dt;
    if (e.ttl <= 0) {
      this.entities.delete(e.id);
      return;
    }
    // attraction toward nearest collecting ship
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const meta of this.players.values()) {
      const p = this.entities.get(meta.pid);
      if (!p || p.dead || p.dockedAt) continue;
      const d = vdist(p.pos, e.pos);
      if (d < meta.stats.collectRadius && d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) {
      const pull = vnorm(vsub(best.pos, e.pos));
      vaddTo(e.vel, vscale(pull, 60 * dt));
      const sp = vlen(e.vel);
      if (sp > 120) e.vel = vscale(e.vel, 120 / sp);
    } else {
      e.vel = vscale(e.vel, Math.max(0, 1 - dt * 0.15));
    }
    vaddTo(e.pos, vscale(e.vel, dt));
  }

  private tickPickups(meta: PlayerMeta, e: Entity): void {
    for (const f of [...this.entities.values()]) {
      if (f.kind !== 'fragment' && f.kind !== 'loot') continue;
      if (vdist(f.pos, e.pos) > PICKUP_DIST + e.radius) continue;
      const prof = meta.profile;
      if (f.kind === 'fragment') {
        const vol = GOODS[f.goodId!].volume * f.qty;
        if (this.cargoFree(meta.pid) < vol) continue; // stays floating
        this.addCargo(prof, f.goodId!, f.qty);
        prof.stats.unitsMined += f.qty;
        this.events.push({ type: 'pickup', pid: meta.pid, good: f.goodId, qty: f.qty, credits: 0 });
      } else {
        if (f.lootCredits > 0) {
          prof.credits += f.lootCredits;
          prof.stats.creditsEarned += f.lootCredits;
        }
        if (f.goodId && f.qty > 0) {
          const vol = GOODS[f.goodId].volume * f.qty;
          if (this.cargoFree(meta.pid) >= vol) this.addCargo(prof, f.goodId, f.qty);
        }
        if (f.lootModule) prof.moduleStash.push({ ...f.lootModule });
        this.events.push({ type: 'pickup', pid: meta.pid, good: f.goodId, qty: f.qty, credits: f.lootCredits });
      }
      this.entities.delete(f.id);
    }
  }

  // -------------------------------------------------------------------------
  // Docking & station services
  // -------------------------------------------------------------------------

  requestDock(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || e.dead || e.dockedAt || meta.docking) return;
    if (e.cruise !== 'off') {
      this.events.push({ type: 'log', text: 'Cannot dock at cruise speed.', color: '#f66', pid });
      return;
    }
    const st = this.system.stations.find((s) => vdist(s.pos, e.pos) < s.dockRadius);
    if (!st) {
      this.events.push({ type: 'log', text: 'No station in docking range.', color: '#f66', pid });
      return;
    }
    if (vlen(e.vel) > DOCK_MAX_SPEED) {
      this.events.push({ type: 'log', text: `Docking denied: reduce speed below ${DOCK_MAX_SPEED} m/s.`, color: '#fa4', pid });
      return;
    }
    meta.docking = { stationId: st.id, t: 0, from: vclone(e.pos) };
    this.events.push({ type: 'log', text: `Docking clearance granted — ${st.name}.`, color: '#8fb', pid });
  }

  private dockShip(meta: PlayerMeta, e: Entity, st: StationDef, viaTow: boolean): void {
    e.dockedAt = st.id;
    e.pos = vclone(st.pos);
    e.vel = v3();
    e.angVel = v3();
    e.firing = false;
    meta.firing = false;
    meta.drillOn = false;
    meta.cruiseRequested = false;
    const prof = meta.profile;
    prof.respawnStation = st.id;
    if (!prof.knownStations.includes(st.id)) prof.knownStations.push(st.id);
    this.events.push({ type: 'docked', pid: meta.pid, stationId: st.id });

    // customs inspection at legal stations
    if (!st.blackMarket && !viaTow) {
      const illegal = prof.cargo.filter((c) => !GOODS[c.good].legal);
      if (illegal.length > 0 && this.rng.chance(SMUGGLING_INSPECTION_CHANCE)) {
        let fine = 0;
        for (const c of illegal) {
          fine += Math.round(GOODS[c.good].basePrice * c.qty * 1.5);
          // confiscating sealed contract cargo fails the contract
          if (c.contractId) {
            const contract = prof.contracts.find((k) => k.id === c.contractId);
            if (contract) this.failContract(meta, contract, 'cargo seized by customs');
          }
        }
        prof.cargo = prof.cargo.filter((c) => GOODS[c.good].legal);
        fine = Math.min(fine, prof.credits);
        prof.credits -= fine;
        this.addRep(prof, st.factionId, -REP_SMUGGLING_PENALTY);
        this.events.push({ type: 'fine', pid: meta.pid, amount: fine, desc: 'contraband seized by station customs' });
      }
    }

    // deliver transport contracts addressed here
    for (const c of [...prof.contracts]) {
      if ((c.type === 'transport' || c.type === 'urgent') && c.dest === st.id) {
        if (this.removeCargo(prof, c.good!, c.qty, c.id)) this.completeContract(meta, c);
      }
      if (c.type === 'supply' && c.dest === st.id && c.good) {
        if (this.freeQty(prof, c.good) >= c.qty && this.removeCargo(prof, c.good, c.qty)) {
          this.completeContract(meta, c);
        }
      }
    }
  }

  undock(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    e.dockedAt = null;
    // launch outward, away from the planet if there is one
    const planet = this.system.planets.find((p) => p.stationId === st.id);
    const dir = planet ? vnorm(vsub(st.pos, planet.pos)) : vnorm(vsub(st.pos, v3()));
    e.pos = vadd(st.pos, vscale(dir, st.radius + 220));
    e.orient = qLookAt(dir);
    e.vel = vscale(dir, 45);
    e.shield = e.maxShield;
    meta.undockInvuln = 4;
    this.events.push({ type: 'undocked', pid, stationId: st.id });
  }

  // ---- market ----

  buyGood(pid: number, goodId: string, qty: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt || qty <= 0 || !Number.isFinite(qty)) return;
    qty = Math.floor(qty);
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('market')) return;
    const def = GOODS[goodId];
    if (!def || (!def.legal && !st.blackMarket)) return;
    const vol = def.volume * qty;
    if (this.cargoFree(pid) < vol) {
      this.events.push({ type: 'log', text: 'Not enough cargo space.', color: '#f66', pid });
      return;
    }
    const stock = this.economy.stockOf(st.id, goodId);
    if (stock < qty) {
      this.events.push({ type: 'log', text: 'Station stock insufficient.', color: '#f66', pid });
      return;
    }
    const preStock = this.economy.stocks.get(st.id)![goodId];
    const cost = this.economy.executeBuy(st.id, goodId, qty, this.time);
    if (cost === null) return;
    if (meta.profile.credits < cost) {
      this.economy.stocks.get(st.id)![goodId] = preStock; // roll back
      this.events.push({ type: 'log', text: 'Insufficient credits.', color: '#f66', pid });
      return;
    }
    meta.profile.credits -= cost;
    this.addCargo(meta.profile, goodId, qty);
    meta.profile.stats.unitsTraded += qty;
    this.events.push({ type: 'tx', pid, good: goodId, qty, total: cost, bought: true });
  }

  sellGood(pid: number, goodId: string, qty: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt || qty <= 0 || !Number.isFinite(qty)) return;
    qty = Math.floor(qty);
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('market')) return;
    const def = GOODS[goodId];
    if (!def || (!def.legal && !st.blackMarket)) {
      this.events.push({ type: 'log', text: 'No buyer for that here. Try the black market.', color: '#fa4', pid });
      return;
    }
    if (this.freeQty(meta.profile, goodId) < qty) return;
    this.removeCargo(meta.profile, goodId, qty);
    const proceeds = this.economy.executeSell(st.id, goodId, qty, this.time);
    meta.profile.credits += proceeds;
    meta.profile.stats.creditsEarned += proceeds;
    meta.profile.stats.unitsTraded += qty;
    this.events.push({ type: 'tx', pid, good: goodId, qty, total: proceeds, bought: false });
  }

  refine(pid: number, inputGood: string, qty: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt || qty <= 0 || !Number.isFinite(qty)) return;
    qty = Math.floor(qty);
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('refinery') || st.refineryEff <= 0) return;
    const recipe = REFINE_RECIPES.find((r) => r.input === inputGood);
    if (!recipe) return;
    if (this.freeQty(meta.profile, inputGood) < qty) return;
    const out = Math.floor((qty / recipe.ratio) * st.refineryEff);
    if (out <= 0) {
      this.events.push({ type: 'log', text: 'Not enough ore for a single output unit.', color: '#fa4', pid });
      return;
    }
    const fee = out * recipe.fee;
    if (meta.profile.credits < fee) {
      this.events.push({ type: 'log', text: 'Cannot afford the refinery fee.', color: '#f66', pid });
      return;
    }
    this.removeCargo(meta.profile, inputGood, qty);
    meta.profile.credits -= fee;
    this.addCargo(meta.profile, recipe.output, out);
    this.events.push({ type: 'refined', pid, goodIn: inputGood, qtyIn: qty, goodOut: recipe.output, qtyOut: out });
  }

  refuel(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('fuel')) return;
    const missing = meta.stats.fuelMax - meta.profile.fuel;
    if (missing <= 0.5) return;
    const cost = Math.ceil(missing * FUEL_PRICE);
    if (meta.profile.credits < cost) {
      // partial refuel with whatever credits remain
      const units = Math.floor(meta.profile.credits / FUEL_PRICE);
      if (units <= 0) return;
      meta.profile.credits -= units * FUEL_PRICE;
      meta.profile.fuel += units;
      this.events.push({ type: 'log', text: `Partial refuel: +${units} units.`, color: '#fa4', pid });
      return;
    }
    meta.profile.credits -= cost;
    meta.profile.fuel = meta.stats.fuelMax;
    this.events.push({ type: 'log', text: `Refueled (${cost} cr).`, color: '#8fb', pid });
  }

  repairHull(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    const missing = Math.ceil(e.maxHull - e.hull);
    if (missing <= 0) return;
    const cost = Math.ceil(missing * REPAIR_PRICE * this.discount(meta.profile, st));
    if (meta.profile.credits < cost) {
      const points = Math.floor(meta.profile.credits / (REPAIR_PRICE * this.discount(meta.profile, st)));
      if (points <= 0) return;
      meta.profile.credits -= Math.ceil(points * REPAIR_PRICE * this.discount(meta.profile, st));
      e.hull = Math.min(e.maxHull, e.hull + points);
      this.events.push({ type: 'log', text: `Partial repairs: +${points} hull.`, color: '#fa4', pid });
      return;
    }
    meta.profile.credits -= cost;
    e.hull = e.maxHull;
    this.events.push({ type: 'log', text: `Hull repaired (${cost} cr).`, color: '#8fb', pid });
  }

  restockMissiles(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const missing = meta.stats.missileAmmoMax - e.missileAmmo;
    if (missing <= 0) return;
    const cost = missing * MISSILE_PRICE;
    if (meta.profile.credits < cost) return;
    meta.profile.credits -= cost;
    e.missileAmmo = meta.stats.missileAmmoMax;
    meta.profile.missileAmmo = e.missileAmmo;
    this.events.push({ type: 'log', text: `Missiles restocked (${cost} cr).`, color: '#8fb', pid });
  }

  restockCannonAmmo(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const missing = meta.stats.cannonAmmoMax - e.cannonAmmo;
    if (missing <= 0) return;
    const cost = Math.ceil(missing * AMMO_PRICE);
    if (meta.profile.credits < cost) {
      const rounds = Math.floor(meta.profile.credits / AMMO_PRICE);
      if (rounds <= 0) return;
      meta.profile.credits -= Math.ceil(rounds * AMMO_PRICE);
      e.cannonAmmo += rounds;
      meta.profile.cannonAmmo = e.cannonAmmo;
      this.events.push({ type: 'log', text: `Partial rearm: +${rounds} rounds.`, color: '#fa4', pid });
      return;
    }
    meta.profile.credits -= cost;
    e.cannonAmmo = meta.stats.cannonAmmoMax;
    meta.profile.cannonAmmo = e.cannonAmmo;
    this.events.push({ type: 'log', text: `Cannon rearmed (${cost} cr).`, color: '#8fb', pid });
  }

  // Field repair: a Hull Patch Kit restores 30% of max hull — but you cannot
  // weld plating while someone is shooting at you.
  useRepairKit(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || e.dead) return;
    if (e.dockedAt) {
      this.events.push({ type: 'log', text: 'Use the station repair service while docked — it is cheaper.', color: '#fa4', pid });
      return;
    }
    if (this.freeQty(meta.profile, 'repair_kit') < 1) return;
    if (e.hull >= e.maxHull - 0.5) {
      this.events.push({ type: 'log', text: 'Hull integrity nominal — save the kit.', color: '#fa4', pid });
      return;
    }
    // combat lockout: recent hits or a hostile actively hunting you
    let inCombat = this.time - meta.lastCombatAt < COMBAT_LOCKOUT_S;
    if (!inCombat) {
      for (const h of this.entities.values()) {
        if (h.kind === 'ship' && h.pirate && h.pirate !== 'turret' && !h.dead
          && h.aggroId === pid && vdist(h.pos, e.pos) < 8000) {
          inCombat = true;
          break;
        }
      }
    }
    if (inCombat) {
      this.events.push({ type: 'log', text: 'Cannot patch the hull under fire — break contact first.', color: '#f66', pid });
      return;
    }
    this.removeCargo(meta.profile, 'repair_kit', 1);
    const healed = Math.round(e.maxHull * REPAIR_KIT_FRACTION);
    e.hull = Math.min(e.maxHull, e.hull + healed);
    this.events.push({ type: 'log', text: `Hull patched: +${healed} integrity. The welds will hold. Probably.`, color: '#8fb', pid });
  }

  useFuelCells(pid: number, qty: number): void {
    const meta = this.players.get(pid);
    if (!meta || qty <= 0 || !Number.isFinite(qty)) return;
    qty = Math.floor(qty);
    if (this.freeQty(meta.profile, 'fuel_cells') < qty) return;
    this.removeCargo(meta.profile, 'fuel_cells', qty);
    meta.profile.fuel = Math.min(meta.stats.fuelMax, meta.profile.fuel + qty * 8);
    this.events.push({ type: 'log', text: `Transferred ${qty} fuel cells to the tank.`, color: '#8fb', pid });
  }

  hailRescue(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || e.dead || e.dockedAt || meta.rescueTimer > 0) return;
    if (meta.profile.fuel > 8) {
      this.events.push({ type: 'log', text: 'Rescue services only answer genuine fuel emergencies.', color: '#fa4', pid });
      return;
    }
    const cost = Math.max(RESCUE_COST_MIN, Math.round(meta.profile.credits * RESCUE_COST_FRACTION));
    const paid = Math.min(cost, meta.profile.credits);
    meta.profile.credits -= paid;
    meta.rescueTimer = RESCUE_DELAY_S;
    this.dropCruise(e, 'rescue');
    e.vel = v3();
    this.events.push({ type: 'rescue', pid, cost: paid });
  }

  // ---- contracts ----

  acceptContract(pid: number, contractId: string): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    const board = this.boards.boardFor(st.id);
    const offer = board.find((c) => c.id === contractId);
    if (!offer) return;
    if (meta.profile.contracts.length >= 6) {
      this.events.push({ type: 'log', text: 'Contract log full (max 6 active).', color: '#f66', pid });
      return;
    }
    if (this.repOf(meta.profile, offer.factionId) < ContractBoards.repRequired(offer)) {
      this.events.push({ type: 'log', text: 'Your standing with this faction is too low for that contract.', color: '#f66', pid });
      return;
    }
    if (offer.type === 'transport' || offer.type === 'urgent') {
      const vol = GOODS[offer.good!].volume * offer.qty;
      if (this.cargoFree(pid) < vol) {
        this.events.push({ type: 'log', text: `Not enough cargo space (${Math.ceil(vol)} m³ needed).`, color: '#f66', pid });
        return;
      }
    }
    const c = this.boards.take(st.id, contractId)!;
    meta.profile.contracts.push(c);
    if (c.type === 'transport' || c.type === 'urgent') {
      this.addCargo(meta.profile, c.good!, c.qty, c.id);
    }
    this.events.push({ type: 'log', text: `Contract accepted: ${c.desc}`, color: '#8fb', pid });
  }

  abandonContract(pid: number, contractId: string): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    const c = meta.profile.contracts.find((k) => k.id === contractId);
    if (!c) return;
    this.failContract(meta, c, 'abandoned');
  }

  // Deliver a supply contract manually from the contracts window.
  deliverSupply(pid: number, contractId: string): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const c = meta.profile.contracts.find((k) => k.id === contractId);
    if (!c || c.type !== 'supply' || c.dest !== e.dockedAt || !c.good) return;
    if (this.freeQty(meta.profile, c.good) < c.qty) {
      this.events.push({ type: 'log', text: 'You do not have the required goods on board.', color: '#f66', pid });
      return;
    }
    this.removeCargo(meta.profile, c.good, c.qty);
    this.completeContract(meta, c);
  }

  private completeContract(meta: PlayerMeta, c: Contract): void {
    meta.profile.contracts = meta.profile.contracts.filter((k) => k.id !== c.id);
    meta.profile.credits += c.reward;
    meta.profile.stats.creditsEarned += c.reward;
    meta.profile.stats.contractsDone++;
    this.addRep(meta.profile, c.factionId, c.repReward);
    this.events.push({ type: 'contractDone', pid: meta.pid, contractId: c.id, reward: c.reward });
  }

  private failContract(meta: PlayerMeta, c: Contract, reason: string): void {
    meta.profile.contracts = meta.profile.contracts.filter((k) => k.id !== c.id);
    // sealed contract cargo is repossessed
    meta.profile.cargo = meta.profile.cargo.filter((ci) => ci.contractId !== c.id);
    this.addRep(meta.profile, c.factionId, -5);
    this.events.push({ type: 'contractFailed', pid: meta.pid, contractId: c.id, desc: `${c.desc} (${reason})` });
  }

  private tickContracts(): void {
    for (const meta of this.players.values()) {
      for (const c of [...meta.profile.contracts]) {
        if (this.time > c.deadline) this.failContract(meta, c, 'deadline expired');
      }
    }
  }

  // ---- shipyard ----

  buyModule(pid: number, slot: ModuleSlot, tier: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt || !Number.isInteger(tier) || tier < 1 || tier > 5) return;
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('shipyard')) return;
    const hull = HULLS[meta.profile.hullId];
    if (tier > hull.slots[slot]) {
      this.events.push({ type: 'log', text: `This hull cannot mount ${MODULE_NAME(slot)} above tier ${hull.slots[slot]}.`, color: '#f66', pid });
      return;
    }
    const current = meta.profile.modules[slot] ?? 0;
    if (current === tier) return;
    const tradeIn = current > 0 ? Math.round(modulePrice(slot, current) * MODULE_SELL_FACTOR) : 0;
    const cost = Math.round(modulePrice(slot, tier) * this.discount(meta.profile, st)) - tradeIn;
    if (meta.profile.credits < cost) {
      this.events.push({ type: 'log', text: 'Insufficient credits.', color: '#f66', pid });
      return;
    }
    meta.profile.credits -= cost;
    meta.profile.modules[slot] = tier;
    this.recomputeStats(pid);
    this.events.push({ type: 'log', text: `Installed ${MODULE_NAME(slot)} Mk ${tier} (${cost >= 0 ? cost : 0} cr).`, color: '#8fb', pid });
  }

  sellModule(pid: number, slot: ModuleSlot): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('shipyard')) return;
    const current = meta.profile.modules[slot] ?? 0;
    if (current === 0) return;
    // core systems can't be removed entirely
    if (slot === 'engine' || slot === 'gyro') {
      this.events.push({ type: 'log', text: 'Cannot fly without that system.', color: '#f66', pid });
      return;
    }
    const value = Math.round(modulePrice(slot, current) * MODULE_SELL_FACTOR);
    meta.profile.credits += value;
    delete meta.profile.modules[slot];
    this.recomputeStats(pid);
    this.events.push({ type: 'log', text: `Sold ${MODULE_NAME(slot)} (+${value} cr).`, color: '#8fb', pid });
  }

  installStashModule(pid: number, index: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('shipyard')) return;
    const item = meta.profile.moduleStash[index];
    if (!item) return;
    const hull = HULLS[meta.profile.hullId];
    if (item.tier > hull.slots[item.slot]) {
      this.events.push({ type: 'log', text: 'This hull cannot mount that module.', color: '#f66', pid });
      return;
    }
    const current = meta.profile.modules[item.slot] ?? 0;
    meta.profile.moduleStash.splice(index, 1);
    if (current > 0) meta.profile.moduleStash.push({ slot: item.slot, tier: current });
    meta.profile.modules[item.slot] = item.tier;
    this.recomputeStats(pid);
    this.events.push({ type: 'log', text: `Installed ${MODULE_NAME(item.slot)} Mk ${item.tier} from stash.`, color: '#8fb', pid });
  }

  sellStashModule(pid: number, index: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('shipyard')) return;
    const item = meta.profile.moduleStash[index];
    if (!item) return;
    meta.profile.moduleStash.splice(index, 1);
    const value = Math.round(modulePrice(item.slot, item.tier) * MODULE_SELL_FACTOR);
    meta.profile.credits += value;
    this.events.push({ type: 'log', text: `Sold ${MODULE_NAME(item.slot)} Mk ${item.tier} (+${value} cr).`, color: '#8fb', pid });
  }

  buyHull(pid: number, hullId: HullId): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('shipyard')) return;
    const def = HULLS[hullId];
    if (!def || hullId === meta.profile.hullId) return;
    const tradeIn = Math.round(HULLS[meta.profile.hullId].price * 0.7);
    const cost = Math.round(def.price * this.discount(meta.profile, st)) - tradeIn;
    if (meta.profile.credits < cost) {
      this.events.push({ type: 'log', text: 'Insufficient credits.', color: '#f66', pid });
      return;
    }
    // cargo must fit in the new hold
    const newStats = shipStats(hullId, meta.profile.modules);
    if (this.cargoVolume(meta.profile) > newStats.cargoCapacity) {
      this.events.push({ type: 'log', text: 'Your cargo would not fit in the new hold. Sell some first.', color: '#f66', pid });
      return;
    }
    meta.profile.credits -= cost;
    meta.profile.hullId = hullId;
    this.recomputeStats(pid);
    const e2 = this.entities.get(pid)!;
    e2.hull = meta.stats.maxHull;
    e2.shield = meta.stats.maxShield;
    this.events.push({ type: 'log', text: `Hull exchanged: ${def.name}. Fly safe.`, color: '#8fb', pid });
  }

  // ---- workshop (rented fabrication bay) ----

  workshopActive(profile: PlayerProfile, stationId: string): boolean {
    return (profile.workshopRentals[stationId] ?? 0) > this.time;
  }

  rentWorkshop(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    if (!st.services.includes('shipyard')) return;
    if (this.workshopActive(meta.profile, st.id)) {
      this.events.push({ type: 'log', text: 'Workshop bay already rented here.', color: '#fa4', pid });
      return;
    }
    if (meta.profile.credits < WORKSHOP_RENT_PRICE) {
      this.events.push({ type: 'log', text: `Workshop rental costs ${WORKSHOP_RENT_PRICE} cr.`, color: '#f66', pid });
      return;
    }
    meta.profile.credits -= WORKSHOP_RENT_PRICE;
    meta.profile.workshopRentals[st.id] = this.time + WORKSHOP_RENT_S;
    this.events.push({ type: 'log', text: `Workshop bay rented at ${st.name} for 24 h (${WORKSHOP_RENT_PRICE} cr).`, color: '#8fb', pid });
  }

  craftModule(pid: number, slot: ModuleSlot, tier: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt || !Number.isInteger(tier) || tier < 1 || tier > 5) return;
    if (!(slot in CRAFT_RECIPES)) return;
    const st = this.station(e.dockedAt)!;
    if (!this.workshopActive(meta.profile, st.id)) {
      this.events.push({ type: 'log', text: 'No active workshop rental at this station.', color: '#f66', pid });
      return;
    }
    const mats = craftMaterials(slot, tier);
    for (const [good, qty] of Object.entries(mats)) {
      if (this.freeQty(meta.profile, good) < qty) {
        this.events.push({ type: 'log', text: `Missing materials: ${qty}× ${GOODS[good].name} needed.`, color: '#f66', pid });
        return;
      }
    }
    for (const [good, qty] of Object.entries(mats)) {
      this.removeCargo(meta.profile, good, qty);
    }
    meta.profile.moduleStash.push({ slot, tier });
    this.events.push({ type: 'log', text: `Fabricated ${MODULE_NAME(slot)} Mk ${tier} — stored in your stash.`, color: '#7fc97f', pid });
  }

  craftRepairKit(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    if (!this.workshopActive(meta.profile, st.id)) {
      this.events.push({ type: 'log', text: 'No active workshop rental at this station.', color: '#f66', pid });
      return;
    }
    for (const [good, qty] of Object.entries(REPAIR_KIT_RECIPE)) {
      if (this.freeQty(meta.profile, good) < qty) {
        this.events.push({ type: 'log', text: `Missing materials: ${qty}× ${GOODS[good].name} needed.`, color: '#f66', pid });
        return;
      }
    }
    if (this.cargoFree(pid) < GOODS.repair_kit.volume) {
      this.events.push({ type: 'log', text: 'Not enough cargo space for the kit.', color: '#f66', pid });
      return;
    }
    for (const [good, qty] of Object.entries(REPAIR_KIT_RECIPE)) {
      this.removeCargo(meta.profile, good, qty);
    }
    this.addCargo(meta.profile, 'repair_kit', 1);
    this.events.push({ type: 'log', text: 'Fabricated 1× Hull Patch Kit.', color: '#7fc97f', pid });
  }

  // ---- warehouse (storage plots) ----

  warehouseVolume(items: CargoItem[]): number {
    return items.reduce((s, c) => s + GOODS[c.good].volume * c.qty, 0);
  }

  buyWarehousePlot(pid: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt) return;
    const st = this.station(e.dockedAt)!;
    const wh = meta.profile.warehouses[st.id];
    const plots = wh ? Math.round(wh.capacity / WAREHOUSE_PLOT_M3) : 0;
    const price = warehousePlotPrice(plots);
    if (meta.profile.credits < price) {
      this.events.push({ type: 'log', text: `A storage plot here costs ${price} cr.`, color: '#f66', pid });
      return;
    }
    meta.profile.credits -= price;
    if (wh) wh.capacity += WAREHOUSE_PLOT_M3;
    else meta.profile.warehouses[st.id] = { capacity: WAREHOUSE_PLOT_M3, items: [] };
    this.events.push({ type: 'log', text: `Storage plot leased at ${st.name}: +${WAREHOUSE_PLOT_M3} m³ (${price} cr).`, color: '#8fb', pid });
  }

  warehouseDeposit(pid: number, goodId: string, qty: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt || qty <= 0 || !Number.isFinite(qty)) return;
    qty = Math.floor(qty);
    const wh = meta.profile.warehouses[e.dockedAt];
    if (!wh || !GOODS[goodId]) return;
    if (this.freeQty(meta.profile, goodId) < qty) return;
    const vol = GOODS[goodId].volume * qty;
    if (this.warehouseVolume(wh.items) + vol > wh.capacity + 1e-6) {
      this.events.push({ type: 'log', text: 'Not enough warehouse space.', color: '#f66', pid });
      return;
    }
    this.removeCargo(meta.profile, goodId, qty);
    const slot = wh.items.find((c) => c.good === goodId);
    if (slot) slot.qty += qty;
    else wh.items.push({ good: goodId, qty });
  }

  warehouseWithdraw(pid: number, goodId: string, qty: number): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || !e.dockedAt || qty <= 0 || !Number.isFinite(qty)) return;
    qty = Math.floor(qty);
    const wh = meta.profile.warehouses[e.dockedAt];
    const slot = wh?.items.find((c) => c.good === goodId);
    if (!wh || !slot || slot.qty < qty) return;
    if (this.cargoFree(pid) < GOODS[goodId].volume * qty) {
      this.events.push({ type: 'log', text: 'Not enough cargo space aboard.', color: '#f66', pid });
      return;
    }
    slot.qty -= qty;
    wh.items = wh.items.filter((c) => c.qty > 0);
    this.addCargo(meta.profile, goodId, qty);
  }

  // ---- navigation ----

  // Buy nav intel on an unvisited station: unlocks its services listing and
  // live market feed, priced by how far away it is.
  buyStationInfo(pid: number, stationId: string): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e) return;
    const st = this.station(stationId);
    if (!st || meta.profile.knownStations.includes(stationId)) return;
    const cost = stationInfoCost(e.pos, st);
    if (meta.profile.credits < cost) {
      this.events.push({ type: 'log', text: `Nav intel on ${st.name} costs ${cost} cr — you cannot afford it.`, color: '#f66', pid });
      return;
    }
    meta.profile.credits -= cost;
    meta.profile.knownStations.push(stationId);
    this.events.push({ type: 'log', text: `Nav intel purchased: ${st.name} (${cost} cr). Market feed unlocked.`, color: '#8fb', pid });
  }

  setDestination(pid: number, dest: Destination | null): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    meta.destination = dest;
  }

  // ---- chat ----

  chat(pid: number, text: string): void {
    const meta = this.players.get(pid);
    const e = this.entities.get(pid);
    if (!meta || !e || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 240);
    if (!trimmed) return;
    this.events.push({
      type: 'chat', from: meta.name, text: trimmed,
      channel: e.dockedAt ? 'station' : 'local', pid,
    });
  }

  // -------------------------------------------------------------------------
  // Queries (for UI)
  // -------------------------------------------------------------------------

  marketFor(stationId: string): MarketEntry[] | null {
    const st = this.station(stationId);
    if (!st) return null;
    return this.economy.market(st, this.time);
  }

  boardFor(stationId: string): Contract[] {
    return this.boards.boardFor(stationId);
  }

  nearestStation(pos: Vec3): StationDef {
    let best = this.system.stations[0];
    let bestD = Infinity;
    for (const s of this.system.stations) {
      const d = vdist(s.pos, pos);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  fieldById(id: string) {
    for (const b of this.system.belts) {
      const f = b.fields.find((x) => x.id === id);
      if (f) return f;
    }
    return undefined;
  }

  dangerAt(pos: Vec3): number {
    return dangerAt(this.system, pos);
  }

  // All rocks whose state differs from pristine (being mined or destroyed),
  // for network sync — clients generate pristine rocks deterministically.
  touchedRocks(): Array<{ fieldId: string; index: number; hp: number }> {
    const out: Array<{ fieldId: string; index: number; hp: number }> = [];
    for (const [key, st] of this.rocks) {
      const sep = key.lastIndexOf(':');
      const fieldId = key.slice(0, sep);
      const index = Number(key.slice(sep + 1));
      const field = this.fieldById(fieldId);
      if (!field) continue;
      const belt = this.system.belts.find((b) => b.id === field.beltId)!;
      const spawn = rockSpawn(field, belt, index);
      const maxHp = spawn.radius * ROCK_TYPES[spawn.type].hpPerRadius;
      if (st.hp < maxHp) out.push({ fieldId, index, hp: Math.max(0, Math.round(st.hp)) });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

function vaddTo(a: Vec3, b: Vec3): void {
  a.x += b.x;
  a.y += b.y;
  a.z += b.z;
}

function vlerpDir(a: Vec3, b: Vec3, t: number): Vec3 {
  return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

// Rotate quaternion a toward b by at most maxAngle radians.
function rotateTowards(a: import('./vec').Quat, b: import('./vec').Quat, maxAngle: number): import('./vec').Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (dot < 0) {
    b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    dot = -dot;
  }
  const angle = 2 * Math.acos(clamp(dot, -1, 1));
  if (angle < 1e-5 || angle <= maxAngle) return qclone(b);
  const t = maxAngle / angle;
  return qnorm({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    w: a.w + (b.w - a.w) * t,
  });
}

function MODULE_NAME(slot: ModuleSlot): string {
  return MODULE_NAMES[slot];
}

// Random small deflection of a direction vector (muzzle spread / aim error).
function jitterDir(dir: Vec3, error: number, rng: Rng): Vec3 {
  if (error <= 0) return dir;
  return vnorm(v3(
    dir.x + rng.range(-error, error),
    dir.y + rng.range(-error, error),
    dir.z + rng.range(-error, error),
  ));
}

// Does the segment a->b pass within `radius` of `center`?
function segmentHitsSphere(a: Vec3, b: Vec3, center: Vec3, radius: number): boolean {
  const ab = vsub(b, a);
  const ac = vsub(center, a);
  const len2 = vlen2(ab);
  const t = len2 > 1e-9 ? clamp(vdot(ac, ab) / len2, 0, 1) : 0;
  const closest = vadd(a, vscale(ab, t));
  return vdist(closest, center) <= radius;
}
