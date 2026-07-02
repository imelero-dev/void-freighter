import type { Quat, Vec3 } from './vec';

export const DT = 1 / 20; // fixed sim tick (s)

// ---------------------------------------------------------------------------
// Commodities
// ---------------------------------------------------------------------------

export type GoodCategory = 'raw' | 'refined' | 'consumer' | 'industrial' | 'illegal';

export interface GoodDef {
  id: string;
  name: string;
  category: GoodCategory;
  basePrice: number;   // credits per unit at equilibrium
  volatility: number;  // 0..1, how widely the price swings
  volume: number;      // m³ per unit of cargo space
  legal: boolean;
}

// ---------------------------------------------------------------------------
// Ships & modules
// ---------------------------------------------------------------------------

export type HullId = 'shuttle' | 'hauler' | 'prospector' | 'interceptor' | 'freighter';

export type ModuleSlot =
  | 'engine' | 'gyro' | 'shield' | 'armor' | 'cargo' | 'weapon' | 'missile'
  | 'drill' | 'collector' | 'scanner' | 'fueltank' | 'nav';

export interface HullDef {
  id: HullId;
  name: string;
  description: string;
  price: number;
  baseCargo: number;      // m³ before cargo module bonus
  baseHull: number;
  baseShield: number;
  accel: number;          // m/s² at engine tier 1
  maxSpeed: number;       // m/s maneuver cap at engine tier 1
  turnRate: number;       // rad/s at gyro tier 1
  cruiseMax: number;      // m/s cruise cap at engine tier 1
  massFactor: number;     // relative inertia: rotation onset + flight-assist authority
  // Max installable tier per slot; 0 = slot not available on this hull.
  slots: Record<ModuleSlot, number>;
}

export interface ModuleDef {
  slot: ModuleSlot;
  tier: number;       // 1..5
  name: string;
  price: number;
  stats: Record<string, number>;
}

// ---------------------------------------------------------------------------
// World bodies (static, generated from seed)
// ---------------------------------------------------------------------------

export type PlanetKind = 'rocky' | 'gas' | 'ice' | 'lava' | 'terran' | 'barren';

export interface PlanetDef {
  id: string;
  name: string;
  kind: PlanetKind;
  pos: Vec3;          // fixed position (orbits are visual only)
  radius: number;
  ringed: boolean;
  colorSeed: number;
  stationId: string | null;
}

export interface MoonDef {
  id: string;
  planetId: string;
  pos: Vec3;
  radius: number;
  colorSeed: number;
}

export type StationService = 'market' | 'contracts' | 'shipyard' | 'refinery' | 'fuel';

export interface StationDef {
  id: string;
  name: string;
  factionId: string;
  pos: Vec3;
  radius: number;       // physical size for render/collision
  dockRadius: number;   // request docking within this range
  safeRadius: number;   // station police zone: no PvP, turrets kill pirates
  services: StationService[];
  // economy profile: goods this station produces (cheap) / consumes (expensive)
  produces: Record<string, number>;  // goodId -> units per economy tick
  consumes: Record<string, number>;
  refineryEff: number;  // 0 if no refinery
  blackMarket: boolean;
  seed: number;
}

export type RockType = 'rocky' | 'metallic' | 'icy' | 'rare';

export interface BeltDef {
  id: string;
  name: string;
  center: Vec3;        // belt ring center (== star usually)
  ringRadius: number;
  fields: FieldDef[];  // minable clusters along the ring
  danger: number;      // 0..1 pirate activity
  composition: Record<RockType, number>; // spawn weights
}

export interface FieldDef {
  id: string;
  beltId: string;
  name: string;
  pos: Vec3;
  radius: number;      // cluster radius (m)
  rockCount: number;
  danger: number;
  seed: number;
}

export interface SystemDef {
  seed: number;
  name: string;
  starRadius: number;
  starColor: number;
  planets: PlanetDef[];
  moons: MoonDef[];
  stations: StationDef[];
  belts: BeltDef[];
  factions: FactionDef[];
}

export interface FactionDef {
  id: string;
  name: string;
  color: number;
  pirate: boolean;
}

// ---------------------------------------------------------------------------
// Entities (dynamic)
// ---------------------------------------------------------------------------

export type EntityKind = 'ship' | 'asteroid' | 'fragment' | 'loot' | 'missile' | 'bolt';

export type PirateTier = 'scout' | 'fighter' | 'raider' | 'elite' | 'corvette' | 'turret';
export type AiState = 'patrol' | 'approach' | 'attack' | 'flee';

export interface Entity {
  id: number;
  kind: EntityKind;
  pos: Vec3;
  vel: Vec3;
  angVel: Vec3; // body-frame angular velocity (rad/s)
  // render interpolation bases (client side fills prev* from snapshots)
  prevPos: Vec3;
  orient: Quat;
  prevOrient: Quat;
  name: string;

  // ships
  isPlayer: boolean;
  pirate: PirateTier | null;
  factionId: string;
  hullId: HullId | 'pirate';
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  shieldRegenTimer: number;  // seconds since last damage
  targetId: number | null;
  firing: boolean;
  weaponCooldown: number;
  dead: boolean;
  throttle: number;          // -0.25..1 of max speed (display)
  cruise: CruiseState;
  cruiseSpeed: number;
  dockedAt: string | null;   // stationId
  // pirate AI
  aiState: AiState;
  aggroId: number | null;
  spawnPos: Vec3;
  aiTimer: number;
  aiPhase: number;           // attack sub-state: 0 reposition, 1 run, 2 break
  missileCooldown: number;
  missileAmmo: number;
  cannonAmmo: number;
  lockTimer: number;         // missile lock progress on current target
  lockedOn: boolean;
  parentId: number;          // turrets: id of the carrier ship (0 = none)
  derelict: boolean;         // inert story wreck
  derelictOpened: boolean;

  // asteroid
  rockType: RockType | null;
  rockHp: number;
  rockMaxHp: number;
  rockYield: Record<string, number> | null; // remaining units per goodId
  fieldId: string | null;
  rockIndex: number;
  radius: number;            // collision/visual radius

  // fragment / loot
  goodId: string | null;
  qty: number;
  lootCredits: number;
  lootModule: { slot: ModuleSlot; tier: number } | null;
  ttl: number;

  // missile
  ownerId: number;
  damage: number;
}

export type CruiseState = 'off' | 'charging' | 'cruise';

// ---------------------------------------------------------------------------
// Player profile (persisted as JSONB / localStorage)
// ---------------------------------------------------------------------------

export interface CargoItem {
  good: string;
  qty: number;
  contractId?: string; // contract cargo: untradeable, lost on death
}

export type ContractType = 'transport' | 'urgent' | 'supply' | 'bounty';

export interface Contract {
  id: string;
  type: ContractType;
  from: string;          // stationId where accepted
  dest: string;          // delivery / hunt-zone station or field id
  good: string | null;
  qty: number;
  killsRequired: number;
  killsDone: number;
  pirateZone: string | null;  // fieldId or stationId anchor for bounty zone
  deadline: number;      // sim world-time (s) when it expires
  reward: number;
  repReward: number;
  factionId: string;
  accepted: boolean;     // false while on a board
  desc: string;
}

export interface PlayerProfile {
  credits: number;
  hullId: HullId;
  modules: Partial<Record<ModuleSlot, number>>; // slot -> tier (0/missing = none)
  hullHp: number;        // persisted hull damage
  fuel: number;
  cargo: CargoItem[];
  contracts: Contract[];
  reputation: Record<string, number>;  // factionId -> -100..100
  dockedAt: string | null;
  respawnStation: string;
  pos: Vec3;
  knownStations: string[];   // visited: market data unlocked
  moduleStash: Array<{ slot: ModuleSlot; tier: number }>; // looted modules, install/sell at shipyard
  missileAmmo: number;
  cannonAmmo: number;
  // workshop rentals: stationId -> world-time expiry of the fabrication bay
  workshopRentals: Record<string, number>;
  // warehouse plots: stationId -> rented storage (volume-limited)
  warehouses: Record<string, { capacity: number; items: CargoItem[] }>;
  stats: {
    kills: number;
    contractsDone: number;
    unitsMined: number;
    unitsTraded: number;
    creditsEarned: number;
    deaths: number;
    distanceTravelled: number;
  };
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface MarketEntry {
  good: string;
  stock: number;
  buyPrice: number;   // what the player pays
  sellPrice: number;  // what the player receives
}

export type EconEventKind = 'shortage' | 'surplus' | 'blockade' | 'boom';

export interface EconEvent {
  kind: EconEventKind;
  stationId: string;
  goodId: string;
  endsAt: number;      // sim time
  priceMult: number;
  headline: string;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ShipInput {
  thrustForward: number;  // -1..1
  thrustRight: number;
  thrustUp: number;
  pitch: number;          // -1..1
  yaw: number;
  roll: number;
  brake: boolean;
  turbo: boolean;         // throttle pinned at 100% and still pushing
}

export function emptyShipInput(): ShipInput {
  return { thrustForward: 0, thrustRight: 0, thrustUp: 0, pitch: 0, yaw: 0, roll: 0, brake: false, turbo: false };
}

// ---------------------------------------------------------------------------
// Destination / GPS
// ---------------------------------------------------------------------------

export type DestKind = 'station' | 'planet' | 'field' | 'entity' | 'point';

export interface Destination {
  kind: DestKind;
  id: string;        // station/planet/field id ('' for point)
  name: string;
  pos: Vec3;
}

// ---------------------------------------------------------------------------
// Sim events (routed to clients for FX / audio / UI log)
// ---------------------------------------------------------------------------

export type SimEvent =
  | { type: 'log'; text: string; color?: string; pid?: number }
  // fx/fy/fz: attacker position when known — drives the HUD damage-direction arrows
  | { type: 'hit'; entityId: number; shield: boolean; amount: number; x: number; y: number; z: number; fx?: number; fy?: number; fz?: number }
  // a ship's shield just collapsed under fire — the moment combat turns
  | { type: 'shieldDown'; entityId: number; x: number; y: number; z: number }
  | { type: 'shot'; entityId: number; x: number; y: number; z: number }
  | { type: 'explosion'; entityId: number; big: boolean; x: number; y: number; z: number }
  | { type: 'laser'; fromId: number; toX: number; toY: number; toZ: number; hit: boolean; mining?: boolean }
  | { type: 'fragment'; entityId: number; x: number; y: number; z: number }
  | { type: 'pickup'; pid: number; good: string | null; qty: number; credits: number }
  | { type: 'docked'; pid: number; stationId: string }
  | { type: 'undocked'; pid: number; stationId: string }
  | { type: 'tx'; pid: number; good: string; qty: number; total: number; bought: boolean }
  | { type: 'contractDone'; pid: number; contractId: string; reward: number }
  | { type: 'contractFailed'; pid: number; contractId: string; desc: string }
  | { type: 'lockWarning'; pid: number }       // an enemy locked onto you
  | { type: 'hostileDetected'; pid: number }
  | { type: 'interdiction'; pid: number }
  | { type: 'death'; pid: number; lostCargo: number; deductible: number }
  | { type: 'chat'; from: string; text: string; channel: 'local' | 'station' | 'system'; pid?: number }
  | { type: 'comms'; pid: number; text: string }  // ambient radio chatter
  | { type: 'econ'; headline: string }
  | { type: 'rescue'; pid: number; cost: number }
  | { type: 'fine'; pid: number; amount: number; desc: string }
  | { type: 'forcefield'; pid: number; body: string }
  | { type: 'derelict'; pid: number; entityId: number; name: string; story: string }
  | { type: 'cruiseChange'; entityId: number; state: CruiseState }
  | { type: 'refined'; pid: number; goodIn: string; qtyIn: number; goodOut: string; qtyOut: number };

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
