// Static game data: commodities, hulls, modules, pirates, refining, balance.
// All balance numbers chosen for the curve documented in docs/design/BALANCE.md.

import type { GoodDef, HullDef, HullId, ModuleSlot, PirateTier } from './types';

// ---------------------------------------------------------------------------
// Commodities
// ---------------------------------------------------------------------------

export const GOODS: Record<string, GoodDef> = {};
function good(id: string, name: string, category: GoodDef['category'], basePrice: number, volatility: number, volume: number, legal = true): void {
  GOODS[id] = { id, name, category, basePrice, volatility, volume, legal };
}

// raw (minable)
good('stone', 'Regolith', 'raw', 2, 0.15, 1.0); // mining gangue — mostly worthless
good('iron_ore', 'Iron Ore', 'raw', 14, 0.30, 1.0);
good('copper_ore', 'Copper Ore', 'raw', 22, 0.35, 1.0);
good('ice', 'Water Ice', 'raw', 8, 0.25, 1.2);
good('silicates', 'Silicate Ore', 'raw', 12, 0.30, 1.0);
good('iridium_ore', 'Iridium Ore', 'raw', 120, 0.45, 0.8);
good('volatiles', 'Volatile Gas', 'raw', 38, 0.40, 1.5);
// refined
good('steel', 'Steel', 'refined', 42, 0.25, 0.8);
good('alloy', 'Conductive Alloy', 'refined', 75, 0.30, 0.8);
good('water', 'Purified Water', 'refined', 16, 0.20, 1.0);
good('fuel_cells', 'Fuel Cells', 'refined', 55, 0.35, 0.6);
good('components', 'Components', 'refined', 90, 0.30, 0.5);
good('iridium', 'Refined Iridium', 'refined', 320, 0.40, 0.4);
// consumer
good('food', 'Foodstuffs', 'consumer', 25, 0.30, 1.0);
good('medicine', 'Medicine', 'consumer', 110, 0.35, 0.4);
good('textiles', 'Textiles', 'consumer', 30, 0.25, 1.1);
good('consumer_goods', 'Consumer Electronics', 'consumer', 85, 0.30, 0.7);
// industrial
good('machinery', 'Heavy Machinery', 'industrial', 140, 0.30, 1.8);
good('ship_parts', 'Ship Parts', 'industrial', 180, 0.30, 1.4);
good('adv_alloys', 'Advanced Alloys', 'industrial', 260, 0.35, 0.9);
// consumable: patches 30% of max hull in the field — never under fire
good('repair_kit', 'Hull Patch Kit', 'industrial', 380, 0.30, 0.6);
// illegal — only tradeable at black market stations
good('stims', 'Combat Stims', 'illegal', 200, 0.55, 0.3, false);
good('small_arms', 'Small Arms', 'illegal', 240, 0.50, 0.6, false);
good('artifacts', 'Relic Artifacts', 'illegal', 520, 0.60, 0.5, false);

export const GOOD_IDS = Object.keys(GOODS);

// Refining: raw -> refined, `ratio` units of input per unit of output before
// station efficiency (0.7–0.9) is applied. fee in credits per output unit.
export interface RefineRecipe { input: string; output: string; ratio: number; fee: number; }
export const REFINE_RECIPES: RefineRecipe[] = [
  { input: 'iron_ore', output: 'steel', ratio: 2, fee: 2 },
  { input: 'copper_ore', output: 'alloy', ratio: 2, fee: 3 },
  { input: 'ice', output: 'water', ratio: 1, fee: 1 },
  { input: 'silicates', output: 'components', ratio: 3, fee: 5 },
  { input: 'volatiles', output: 'fuel_cells', ratio: 2, fee: 3 },
  { input: 'iridium_ore', output: 'iridium', ratio: 2, fee: 10 },
];

// ---------------------------------------------------------------------------
// Hulls
// ---------------------------------------------------------------------------

function slots(s: Partial<Record<ModuleSlot, number>>): Record<ModuleSlot, number> {
  return {
    engine: 3, gyro: 3, shield: 3, armor: 2, cargo: 3, weapon: 2, missile: 1,
    drill: 2, collector: 2, scanner: 3, fueltank: 3, nav: 3, ...s,
  };
}

export const HULLS: Record<HullId, HullDef> = {
  shuttle: {
    id: 'shuttle', name: 'CL-7 Vagrant', description: 'Surplus courier shuttle. It leaks, but it flies.',
    price: 0, baseCargo: 30, baseHull: 80, baseShield: 50,
    accel: 36, maxSpeed: 190, turnRate: 2.2, cruiseMax: 220_000, massFactor: 1,
    slots: slots({}),
  },
  hauler: {
    id: 'hauler', name: 'KM-300 Mule', description: 'Boxy mid-range hauler. The freight line workhorse.',
    price: 16_000, baseCargo: 140, baseHull: 150, baseShield: 80,
    accel: 26, maxSpeed: 165, turnRate: 1.5, cruiseMax: 260_000, massFactor: 1.5,
    slots: slots({ cargo: 5, weapon: 2, missile: 2, drill: 2, fueltank: 4, armor: 3 }),
  },
  prospector: {
    id: 'prospector', name: 'DV-9 Magpie', description: 'Mining frame with oversized drill mounts and ore scoops.',
    price: 34_000, baseCargo: 90, baseHull: 140, baseShield: 100,
    accel: 31, maxSpeed: 180, turnRate: 1.7, cruiseMax: 250_000, massFactor: 1.3,
    slots: slots({ drill: 5, collector: 5, scanner: 5, weapon: 2, missile: 1, cargo: 4 }),
  },
  interceptor: {
    id: 'interceptor', name: 'SX-4 Harrier', description: 'Ex-militia gunship. Fast, angry, and cramped.',
    price: 62_000, baseCargo: 45, baseHull: 190, baseShield: 170,
    accel: 48, maxSpeed: 265, turnRate: 2.9, cruiseMax: 300_000, massFactor: 0.8,
    slots: slots({ weapon: 5, missile: 5, shield: 5, armor: 4, engine: 5, gyro: 5, cargo: 2, drill: 1 }),
  },
  freighter: {
    id: 'freighter', name: 'TT-90 Leviathan', description: 'Heavy freight platform. A warehouse with engines.',
    price: 150_000, baseCargo: 420, baseHull: 340, baseShield: 200,
    accel: 18, maxSpeed: 140, turnRate: 1.0, cruiseMax: 280_000, massFactor: 2.5,
    slots: slots({ cargo: 5, armor: 5, shield: 4, weapon: 3, missile: 3, fueltank: 5, drill: 2 }),
  },
};

// New ships ship with these modules pre-installed.
export const STARTER_MODULES: Partial<Record<ModuleSlot, number>> = {
  engine: 1, gyro: 1, shield: 1, weapon: 1, scanner: 1, fueltank: 1, nav: 1, collector: 1,
};

// ---------------------------------------------------------------------------
// Modules — stats derived from slot + tier, price = base * tier².
// ---------------------------------------------------------------------------

const MODULE_PRICE_BASE: Record<ModuleSlot, number> = {
  engine: 900, gyro: 700, shield: 1100, armor: 800, cargo: 1000, weapon: 1200,
  missile: 900, drill: 850, collector: 600, scanner: 750, fueltank: 500, nav: 550,
};

export const MODULE_NAMES: Record<ModuleSlot, string> = {
  engine: 'Drive', gyro: 'Gyro Array', shield: 'Shield Generator', armor: 'Hull Plating',
  cargo: 'Cargo Racks', weapon: 'Pulse Cannon', missile: 'Missile Rack', drill: 'Mining Drill',
  collector: 'Collector Field', scanner: 'Sensor Suite', fueltank: 'Fuel Tank', nav: 'Nav Computer',
};

export const MODULE_TIER_TAGS = ['', 'Mk I', 'Mk II', 'Mk III', 'Mk IV', 'Mk V'];

export function modulePrice(slot: ModuleSlot, tier: number): number {
  return Math.round(MODULE_PRICE_BASE[slot] * tier * tier);
}
export const MODULE_SELL_FACTOR = 0.65;
export const SHIP_TRADE_IN_FACTOR = 0.7;

// Derived ship stats from hull + installed module tiers.
export interface ShipStats {
  maxSpeed: number;       // m/s maneuver
  accel: number;          // m/s²
  turnRate: number;       // rad/s
  cruiseMax: number;      // m/s
  maxHull: number;
  maxShield: number;
  shieldRegen: number;    // hp/s after delay
  cargoCapacity: number;  // m³
  weaponDamage: number;   // per shot
  weaponRange: number;
  weaponInterval: number; // s between shots
  cannonAmmoMax: number;  // rounds in the magazine
  missileAmmoMax: number;
  missileDamage: number;
  missileLockTime: number;
  drillRate: number;      // units/s, 0 = no drill
  drillRange: number;
  collectRadius: number;
  sensorRange: number;    // blip detection
  resolveRange: number;   // identify contacts
  compositionScan: boolean; // asteroid composition readout
  fuelMax: number;
  navQuality: number;     // 0 = degraded marker, 1+ = full GPS
}

export function shipStats(hullId: HullId, modules: Partial<Record<ModuleSlot, number>>): ShipStats {
  const h = HULLS[hullId];
  const t = (slot: ModuleSlot): number => Math.min(modules[slot] ?? 0, h.slots[slot]);
  const eng = Math.max(1, t('engine')), gyro = Math.max(1, t('gyro'));
  const shield = t('shield'), armor = t('armor'), cargo = t('cargo');
  const weapon = t('weapon'), missile = t('missile'), drill = t('drill');
  const collector = t('collector'), scanner = Math.max(1, t('scanner'));
  const fuel = Math.max(1, t('fueltank')), nav = t('nav');
  return {
    maxSpeed: h.maxSpeed * (1 + 0.15 * (eng - 1)),
    accel: h.accel * (1 + 0.20 * (eng - 1)),
    turnRate: h.turnRate * (1 + 0.16 * (gyro - 1)),
    cruiseMax: h.cruiseMax * (1 + 0.28 * (eng - 1)),
    maxHull: Math.round(h.baseHull * (1 + 0.25 * armor)),
    maxShield: shield === 0 ? 0 : Math.round(h.baseShield * (1 + 0.35 * (shield - 1))),
    shieldRegen: shield === 0 ? 0 : 2 + 1.5 * shield,
    cargoCapacity: Math.round(h.baseCargo * (1 + 0.4 * cargo)),
    weaponDamage: weapon === 0 ? 0 : 6 + 4 * weapon,
    weaponRange: 1000 + 120 * weapon,
    weaponInterval: 0.34 - 0.015 * weapon,
    cannonAmmoMax: weapon === 0 ? 0 : 240 + 80 * weapon,
    missileAmmoMax: missile === 0 ? 0 : 2 + 2 * missile,
    missileDamage: 50 + 35 * missile,
    missileLockTime: Math.max(1.2, 3.0 - 0.3 * missile),
    drillRate: drill === 0 ? 0 : 1.2 + 0.8 * drill,
    drillRange: 500 + 150 * drill,
    collectRadius: 80 + 60 * collector,
    sensorRange: 6000 * (1 + 0.5 * (scanner - 1)),
    resolveRange: 2500 * (1 + 0.4 * (scanner - 1)),
    compositionScan: scanner >= 3,
    fuelMax: 100 + 60 * (fuel - 1),
    navQuality: nav,
  };
}

// Total resale value of a fitted ship (for insurance deductible math).
export function shipValue(hullId: HullId, modules: Partial<Record<ModuleSlot, number>>): number {
  let v = HULLS[hullId].price;
  for (const [slot, tier] of Object.entries(modules)) {
    if (tier && tier > 0) v += modulePrice(slot as ModuleSlot, tier);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Fuel / repair / insurance
// ---------------------------------------------------------------------------

export const FUEL_PRICE = 2;            // cr per unit
export const REPAIR_PRICE = 2.5;        // cr per hull point
export const MISSILE_PRICE = 30;        // cr per missile restock
export const AMMO_PRICE = 0.6;          // cr per cannon round
export const REPAIR_KIT_FRACTION = 0.3; // hull restored per kit
export const COMBAT_LOCKOUT_S = 10;     // no field repairs this soon after taking fire

// ---------------------------------------------------------------------------
// Workshop (rented fabrication bay) & Warehouse (storage plots)
// ---------------------------------------------------------------------------

export const WORKSHOP_RENT_PRICE = 2500;       // cr per station
export const WORKSHOP_RENT_S = 24 * 3600;      // 24 h of world time
// Materials per module = base recipe × tier² × 0.8 (≈55-65% of market price
// in raw material value — crafting pays off if you mine/refine your own)
export const CRAFT_RECIPES: Record<ModuleSlot, Record<string, number>> = {
  engine: { steel: 6, alloy: 3, machinery: 1 },
  gyro: { steel: 4, alloy: 3, components: 1 },
  shield: { alloy: 4, components: 3 },
  armor: { steel: 8, adv_alloys: 1 },
  cargo: { steel: 8, textiles: 2 },
  weapon: { steel: 5, components: 3, alloy: 2 },
  missile: { steel: 4, components: 2, machinery: 1 },
  drill: { steel: 6, machinery: 2 },
  collector: { alloy: 3, components: 2 },
  scanner: { components: 4, alloy: 2 },
  fueltank: { steel: 5, water: 2 },
  nav: { components: 3, alloy: 1 },
};

export function craftMaterials(slot: ModuleSlot, tier: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [good, qty] of Object.entries(CRAFT_RECIPES[slot])) {
    out[good] = Math.ceil(qty * tier * tier * 0.8);
  }
  return out;
}

// consumable recipe: hull patch kits can be fabricated too
export const REPAIR_KIT_RECIPE: Record<string, number> = { steel: 5, components: 1 };

export const WAREHOUSE_PLOT_M3 = 250;          // capacity per plot
export function warehousePlotPrice(existingPlots: number): number {
  return 3500 + existingPlots * 1750;          // each extra plot costs more
}
export const CRUISE_FUEL_PER_S = 0.25;  // at full cruise speed fraction
export const INSURANCE_DEDUCTIBLE = 0.12; // fraction of ship value on death
export const RESCUE_COST_FRACTION = 0.2;  // of credits, min below
export const RESCUE_COST_MIN = 400;

// ---------------------------------------------------------------------------
// Pirates
// ---------------------------------------------------------------------------

// Weapon bolts are simulated projectiles: travel time + spread means shots
// can miss — strafing genuinely dodges fire.
export const BOLT_SPEED = 1100;        // m/s, relative to the shooter
export const PLAYER_AIM_SPREAD = 0.007; // rad of muzzle wander

export interface PirateDef {
  tier: PirateTier;
  name: string;
  hull: number;
  shield: number;
  maxSpeed: number;
  accel: number;
  turnRate: number;
  shotDamage: number;
  shotInterval: number;
  weaponRange: number;
  aimError: number;     // rad — lower tiers spray, elites snipe
  missiles: number;       // ammo (raider/elite)
  missileDamage: number;
  detectRange: number;
  creditsMin: number;
  creditsMax: number;
  moduleChance: number;   // loot roll
  moduleTierMax: number;
  bounty: number;         // contract kill value
}

export const PIRATES: Record<PirateTier, PirateDef> = {
  scout: {
    tier: 'scout', name: 'Scrapper Scout', hull: 40, shield: 25, maxSpeed: 155, accel: 26,
    turnRate: 1.5, shotDamage: 8, shotInterval: 0.42, weaponRange: 1000, aimError: 0.05, missiles: 0,
    missileDamage: 0, detectRange: 5200, creditsMin: 60, creditsMax: 180,
    moduleChance: 0.02, moduleTierMax: 1, bounty: 150,
  },
  fighter: {
    tier: 'fighter', name: 'Scrapper Fighter', hull: 75, shield: 55, maxSpeed: 165, accel: 28,
    turnRate: 1.6, shotDamage: 11, shotInterval: 0.38, weaponRange: 1100, aimError: 0.038, missiles: 0,
    missileDamage: 0, detectRange: 5800, creditsMin: 150, creditsMax: 420,
    moduleChance: 0.05, moduleTierMax: 2, bounty: 260,
  },
  raider: {
    tier: 'raider', name: 'Scrapper Raider', hull: 135, shield: 100, maxSpeed: 155, accel: 25,
    turnRate: 1.3, shotDamage: 15, shotInterval: 0.36, weaponRange: 1200, aimError: 0.03, missiles: 2,
    missileDamage: 90, detectRange: 6400, creditsMin: 380, creditsMax: 900,
    moduleChance: 0.12, moduleTierMax: 3, bounty: 480,
  },
  elite: {
    tier: 'elite', name: 'Scrapper Warlord', hull: 280, shield: 220, maxSpeed: 175, accel: 30,
    turnRate: 1.7, shotDamage: 22, shotInterval: 0.32, weaponRange: 1350, aimError: 0.02, missiles: 6,
    missileDamage: 110, detectRange: 7500, creditsMin: 1000, creditsMax: 2400,
    moduleChance: 0.35, moduleTierMax: 5, bounty: 1100,
  },
  // gun platform mini-boss: huge shield + hull, barely turns — its escort of
  // destructible autocannon turrets is the real threat
  corvette: {
    tier: 'corvette', name: 'Scrapper Ironclad', hull: 850, shield: 600, maxSpeed: 85, accel: 10,
    turnRate: 0.3, shotDamage: 34, shotInterval: 1.8, weaponRange: 1600, aimError: 0.03, missiles: 0,
    missileDamage: 0, detectRange: 8000, creditsMin: 2400, creditsMax: 5200,
    moduleChance: 0.7, moduleTierMax: 5, bounty: 2600,
  },
  turret: {
    tier: 'turret', name: 'Ironclad Autocannon', hull: 55, shield: 35, maxSpeed: 0, accel: 0,
    turnRate: 0, shotDamage: 5, shotInterval: 0.16, weaponRange: 1100, aimError: 0.055, missiles: 0,
    missileDamage: 0, detectRange: 7000, creditsMin: 20, creditsMax: 70,
    moduleChance: 0, moduleTierMax: 1, bounty: 150,
  },
};

// ---------------------------------------------------------------------------
// Ambient traffic (AI-LIFE)
// ---------------------------------------------------------------------------

export interface NpcDef {
  kind: import('./types').NpcKind;
  hull: number;
  shield: number;
  maxSpeed: number;
  accel: number;
  turnRate: number;
  laneSpeed: number;      // m/s while riding a trade lane
  shotDamage: number;     // 0 = unarmed
  shotInterval: number;
  weaponRange: number;
  aimError: number;
  radius: number;
}

export const NPC_DEFS: Record<import('./types').NpcKind, NpcDef> = {
  superfreighter: {
    kind: 'superfreighter', hull: 4000, shield: 1500, maxSpeed: 60, accel: 5, turnRate: 0.1,
    laneSpeed: 260, shotDamage: 0, shotInterval: 1, weaponRange: 0, aimError: 0, radius: 280,
  },
  freighter: {
    kind: 'freighter', hull: 320, shield: 160, maxSpeed: 115, accel: 14, turnRate: 0.7,
    laneSpeed: 460, shotDamage: 0, shotInterval: 1, weaponRange: 0, aimError: 0, radius: 26,
  },
  courier: {
    kind: 'courier', hull: 90, shield: 60, maxSpeed: 200, accel: 34, turnRate: 1.8,
    laneSpeed: 640, shotDamage: 0, shotInterval: 1, weaponRange: 0, aimError: 0, radius: 10,
  },
  patrol: {
    kind: 'patrol', hull: 220, shield: 200, maxSpeed: 230, accel: 42, turnRate: 2.2,
    laneSpeed: 600, shotDamage: 16, shotInterval: 0.3, weaponRange: 1300, aimError: 0.025, radius: 12,
  },
  merchant: {
    kind: 'merchant', hull: 260, shield: 220, maxSpeed: 120, accel: 16, turnRate: 0.9,
    laneSpeed: 380, shotDamage: 12, shotInterval: 0.5, weaponRange: 1000, aimError: 0.04, radius: 16,
  },
};

export const MERCHANT_HAIL_RANGE = 900;     // m to open trade
export const MERCHANT_SELL_FACTOR = 0.85;   // they fence your goods at 85% base
export const DISTRESS_REWARD_MIN = 300;
export const DISTRESS_REWARD_MAX = 900;
export const CIV_KILL_REP_PENALTY = 4;      // shooting civilians has consequences

// Pirate loot: goods rolled from this table (id, min, max, weight).
export const PIRATE_GOOD_DROPS: Array<{ good: string; min: number; max: number; weight: number }> = [
  { good: 'steel', min: 2, max: 8, weight: 3 },
  { good: 'fuel_cells', min: 2, max: 6, weight: 3 },
  { good: 'components', min: 1, max: 5, weight: 2.5 },
  { good: 'medicine', min: 1, max: 4, weight: 1.5 },
  { good: 'stims', min: 1, max: 4, weight: 1.5 },
  { good: 'small_arms', min: 1, max: 3, weight: 1.2 },
  { good: 'consumer_goods', min: 1, max: 5, weight: 2 },
  { good: 'artifacts', min: 1, max: 1, weight: 0.3 },
];

// ---------------------------------------------------------------------------
// Asteroids
// ---------------------------------------------------------------------------

export interface RockDef {
  hpPerRadius: number;             // rockHp = radius * this
  yields: Array<{ good: string; weight: number }>;
  yieldPerRadius: number;          // total extractable units = radius * this
}

export const ROCK_TYPES: Record<string, RockDef> = {
  rocky: {
    hpPerRadius: 3.2, yieldPerRadius: 1.5,
    yields: [{ good: 'iron_ore', weight: 5 }, { good: 'silicates', weight: 3 }],
  },
  metallic: {
    hpPerRadius: 4.0, yieldPerRadius: 1.3,
    yields: [{ good: 'copper_ore', weight: 5 }, { good: 'iron_ore', weight: 2 }],
  },
  icy: {
    hpPerRadius: 2.6, yieldPerRadius: 1.7,
    yields: [{ good: 'ice', weight: 5 }, { good: 'volatiles', weight: 2 }],
  },
  rare: {
    hpPerRadius: 5.0, yieldPerRadius: 0.9,
    yields: [{ good: 'iridium_ore', weight: 4 }, { good: 'copper_ore', weight: 2 }],
  },
};

export const ASTEROID_RESPAWN_S = 600; // mined-out rock regrows after 10 min
// Mining beam: hold-to-fire with heat. Grindy by design — most pulls are
// worthless regolith unless you work the glowing seams (hotspots).
export const DRILL_HEAT_PER_S = 1 / 6;     // ~6 s of continuous beam to overheat
export const DRILL_COOL_PER_S = 1 / 5;
export const DRILL_OVERHEAT_RESUME = 0.35; // must cool below this to re-fire
export const MINING_RATE_FACTOR = 0.4;     // global slowdown vs old auto-miner
export const ORE_CHANCE_BASE = 0.28;       // real material odds per fragment
export const ORE_CHANCE_HOTSPOT = 0.75;    // when carving a hotspot seam
export const HOTSPOT_CONE = 0.5;           // rad from hotspot axis that counts

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

export const REP_CONTRACT_GATE_T2 = 10;  // rep needed for better contracts
export const REP_CONTRACT_GATE_T3 = 25;
export const REP_DISCOUNT_MAX = 0.12;    // shipyard/repair discount at rep 50+
export const REP_SMUGGLING_PENALTY = 3;
export const SMUGGLING_INSPECTION_CHANCE = 0.3;

// ---------------------------------------------------------------------------
// Misc world tuning
// ---------------------------------------------------------------------------

export const DOCK_MAX_SPEED = 60;       // m/s relative to station for docking
export const STATION_TURRET_DPS = 45;   // applied to hostiles inside safeRadius
export const SHIELD_REGEN_DELAY = 6;    // s without damage before regen
export const CRUISE_CHARGE_S = 3;       // spool-up time
export const CRUISE_ACCEL_DOUBLE_S = 2.2; // cruise speed doubles every N s
export const CRUISE_MIN_SPEED = 800;    // m/s entry speed
export const CRUISE_MASS_LOCK = 220_000; // m from planet/station center: cruise drops out (scaled by body)
export const CRUISE_DROP_SPEED = 220;   // exit speed after cruise
export const COLLISION_DAMAGE_SPEED = 90; // m/s impact over this damages hull

// Turbo overburn: hold throttle-up at 100% to push past the speed cap.
// Free in safe space; with hostiles nearby it drains a burst gauge.
export const TURBO_SPEED = 1000;          // m/s ceiling
export const TURBO_ACCEL_MULT = 2.2;
export const TURBO_BURST_S = 3.5;         // gauge duration in combat
export const TURBO_RECHARGE_S = 9;        // empty -> full
export const TURBO_ENEMY_RADIUS = 6000;   // hostiles inside this force burst mode
