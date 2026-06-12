// Procedural star system generation. Deterministic from seed: every client and
// the server generate the exact same system, so only dynamic state is synced.

import { Rng } from './rng';
import type { BeltDef, FactionDef, FieldDef, MoonDef, PlanetDef, RockType, StationDef, SystemDef } from './types';
import { v3, type Vec3 } from './vec';

export const WORLD_SEED = 7741;

export const FACTIONS: FactionDef[] = [
  { id: 'helion', name: 'Helion Combine', color: 0xcc8833, pirate: false },
  { id: 'meridian', name: 'Meridian Charter', color: 0x5588aa, pirate: false },
  { id: 'outwarden', name: 'Outwarden Assembly', color: 0x779966, pirate: false },
  { id: 'drift', name: 'Drift Syndicate', color: 0xaa66aa, pirate: false },
  { id: 'scrappers', name: 'The Scrappers', color: 0xbb3322, pirate: true },
];

interface PlanetSpec {
  id: string; name: string; kind: PlanetDef['kind']; orbit: number; radius: number; ringed: boolean;
  station: StationSpec | null; moons: number;
}
interface StationSpec {
  id: string; name: string; faction: string;
  services: StationDef['services'];
  produces: Record<string, number>;
  consumes: Record<string, number>;
  refineryEff: number;
  blackMarket: boolean;
}

// Curated topology; angles/offsets/fields are seeded. Production/consumption
// rates are units per economy tick (5 s) — they define each station's price
// profile and thus the arbitrage routes.
const PLANETS: PlanetSpec[] = [
  {
    id: 'cinder', name: 'Cinder', kind: 'lava', orbit: 6.0e6, radius: 62_000, ringed: false, moons: 0,
    station: {
      id: 'cinder_forge', name: 'Cinder Forge', faction: 'helion',
      services: ['market', 'contracts', 'fuel', 'refinery', 'shipyard'],
      produces: { steel: 5, alloy: 3, adv_alloys: 1.2, repair_kit: 0.5 },
      consumes: { food: 4, water: 5, medicine: 1.2, iron_ore: 6, copper_ore: 4 },
      refineryEff: 0.9, blackMarket: false,
    },
  },
  {
    id: 'bren', name: 'Bren', kind: 'rocky', orbit: 1.1e7, radius: 88_000, ringed: false, moons: 0,
    station: {
      id: 'bren_yards', name: 'Bren Yards', faction: 'helion',
      services: ['market', 'contracts', 'fuel', 'shipyard', 'refinery'],
      produces: { ship_parts: 2.5, machinery: 3, repair_kit: 0.6 },
      consumes: { steel: 6, alloy: 4, components: 4, food: 3.5, textiles: 1.5 },
      refineryEff: 0.85, blackMarket: false,
    },
  },
  {
    id: 'morrow', name: 'Morrow', kind: 'terran', orbit: 1.7e7, radius: 112_000, ringed: false, moons: 1,
    station: {
      id: 'morrow_granary', name: 'Morrow Granary', faction: 'meridian',
      services: ['market', 'contracts', 'fuel'],
      produces: { food: 8, textiles: 4, water: 3 },
      consumes: { machinery: 2.5, medicine: 1.5, consumer_goods: 2.5, fuel_cells: 2 },
      refineryEff: 0, blackMarket: false,
    },
  },
  {
    id: 'halcyon', name: 'Halcyon', kind: 'gas', orbit: 2.6e7, radius: 330_000, ringed: true, moons: 2,
    station: {
      id: 'halcyon_skyhook', name: 'Halcyon Skyhook', faction: 'meridian',
      services: ['market', 'contracts', 'fuel', 'refinery'],
      produces: { volatiles: 6, fuel_cells: 4 },
      consumes: { food: 4, components: 3, machinery: 2, water: 3 },
      refineryEff: 0.8, blackMarket: false,
    },
  },
  {
    id: 'veil', name: 'Veil', kind: 'ice', orbit: 3.4e7, radius: 94_000, ringed: false, moons: 1,
    station: {
      id: 'veil_anchorage', name: 'Veil Anchorage', faction: 'outwarden',
      services: ['market', 'contracts', 'fuel', 'refinery'],
      produces: { ice: 7, water: 4, medicine: 2 },
      consumes: { fuel_cells: 3, food: 3, consumer_goods: 2, steel: 2.5 },
      refineryEff: 0.8, blackMarket: false,
    },
  },
  {
    id: 'khar', name: 'Khar', kind: 'barren', orbit: 4.3e7, radius: 74_000, ringed: false, moons: 0,
    station: {
      id: 'khar_terminal', name: 'Khar Terminal', faction: 'outwarden',
      services: ['market', 'contracts', 'fuel', 'shipyard', 'refinery'],
      produces: { iridium: 0.8 },
      consumes: { food: 4, water: 4, machinery: 2, ship_parts: 1.5, medicine: 1.5, fuel_cells: 2.5 },
      refineryEff: 0.75, blackMarket: false,
    },
  },
];

// Independent stations (not orbiting a planet).
const FREE_STATIONS: Array<StationSpec & { orbit: number; offPlane: number }> = [
  {
    id: 'the_drift', name: 'The Drift', faction: 'drift', orbit: 2.1e7, offPlane: 3e5,
    services: ['market', 'contracts', 'fuel', 'shipyard'],
    produces: { consumer_goods: 3.5, electronics: 0, components: 2 },
    consumes: { food: 3, water: 2.5, steel: 2, textiles: 2, medicine: 1 },
    refineryEff: 0, blackMarket: false,
  },
  {
    id: 'rusthaven', name: 'Rusthaven', faction: 'scrappers', orbit: 3.9e7, offPlane: -8e5,
    services: ['market', 'contracts', 'fuel', 'shipyard', 'refinery'],
    produces: { stims: 2, small_arms: 1.5 },
    consumes: { food: 3, water: 3, fuel_cells: 2, medicine: 2, artifacts: 0.4, steel: 1.5 },
    refineryEff: 0.7, blackMarket: true,
  },
];

interface BeltSpec {
  id: string; name: string; ring: number; fieldCount: number; danger: number;
  composition: Record<RockType, number>;
}
const BELTS: BeltSpec[] = [
  {
    id: 'ironline', name: 'Ironline Belt', ring: 1.4e7, fieldCount: 5, danger: 0.15,
    composition: { rocky: 6, metallic: 2, icy: 0, rare: 0 },
  },
  {
    id: 'midreach', name: 'Midreach Scatter', ring: 2.35e7, fieldCount: 4, danger: 0.35,
    composition: { rocky: 2, metallic: 6, icy: 0, rare: 0.2 },
  },
  {
    id: 'veilshard', name: 'Veilshard Ring', ring: 3.55e7, fieldCount: 4, danger: 0.5,
    composition: { rocky: 1, metallic: 1, icy: 6, rare: 0.3 },
  },
  {
    id: 'shatter', name: 'The Shatter', ring: 4.6e7, fieldCount: 3, danger: 0.85,
    composition: { rocky: 1, metallic: 3, icy: 0, rare: 3 },
  },
];

const FIELD_NAMES = ['Claim', 'Drift', 'Pocket', 'Reach', 'Hollow', 'Scatter', 'Graveyard', 'Verge'];

export function generateSystem(seed: number = WORLD_SEED): SystemDef {
  const rng = new Rng(seed);
  const planets: PlanetDef[] = [];
  const moons: MoonDef[] = [];
  const stations: StationDef[] = [];

  for (const spec of PLANETS) {
    const angle = rng.range(0, Math.PI * 2);
    const y = rng.range(-2e5, 2e5);
    const pos = v3(Math.cos(angle) * spec.orbit, y, Math.sin(angle) * spec.orbit);
    const planet: PlanetDef = {
      id: spec.id, name: spec.name, kind: spec.kind, pos, radius: spec.radius,
      ringed: spec.ringed, colorSeed: rng.int(1, 1e9), stationId: spec.station?.id ?? null,
    };
    planets.push(planet);
    for (let m = 0; m < spec.moons; m++) {
      const ma = rng.range(0, Math.PI * 2);
      const md = spec.radius * rng.range(3.5, 6);
      moons.push({
        id: `${spec.id}_moon${m}`, planetId: spec.id,
        pos: v3(pos.x + Math.cos(ma) * md, pos.y + rng.range(-0.4, 0.4) * spec.radius, pos.z + Math.sin(ma) * md),
        radius: spec.radius * rng.range(0.12, 0.25), colorSeed: rng.int(1, 1e9),
      });
    }
    if (spec.station) {
      // Station orbits just outside the planet, offset sunward-ish for light.
      const sa = rng.range(0, Math.PI * 2);
      const sd = spec.radius * 2.2;
      stations.push(makeStation(spec.station, v3(
        pos.x + Math.cos(sa) * sd, pos.y + spec.radius * 0.3, pos.z + Math.sin(sa) * sd,
      ), rng.int(1, 1e9)));
    }
  }

  for (const spec of FREE_STATIONS) {
    const angle = rng.range(0, Math.PI * 2);
    stations.push(makeStation(spec, v3(
      Math.cos(angle) * spec.orbit, spec.offPlane, Math.sin(angle) * spec.orbit,
    ), rng.int(1, 1e9)));
  }

  const belts: BeltDef[] = BELTS.map((spec) => {
    const fields: FieldDef[] = [];
    const baseAngle = rng.range(0, Math.PI * 2);
    for (let i = 0; i < spec.fieldCount; i++) {
      const angle = baseAngle + (i / spec.fieldCount) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const r = spec.ring + rng.range(-6e5, 6e5);
      fields.push({
        id: `${spec.id}_f${i}`,
        beltId: spec.id,
        name: `${spec.name.split(' ')[0]} ${rng.pick(FIELD_NAMES)} ${String.fromCharCode(65 + i)}`,
        pos: v3(Math.cos(angle) * r, rng.range(-3e5, 3e5), Math.sin(angle) * r),
        radius: rng.range(5000, 9000),
        rockCount: rng.int(50, 110),
        danger: Math.min(1, spec.danger + rng.range(-0.08, 0.12)),
        seed: rng.int(1, 1e9),
      });
    }
    return {
      id: spec.id, name: spec.name, center: v3(0, 0, 0), ringRadius: spec.ring,
      fields, danger: spec.danger, composition: spec.composition,
    };
  });

  return {
    seed, name: 'Vesper System', starRadius: 250_000, starColor: 0xffa040,
    planets, moons, stations, belts, factions: FACTIONS,
  };
}

function makeStation(spec: StationSpec, pos: Vec3, seed: number): StationDef {
  return {
    id: spec.id, name: spec.name, factionId: spec.faction, pos,
    radius: 900, dockRadius: 2200, safeRadius: 14_000,
    services: spec.services,
    produces: { ...spec.produces },
    consumes: { ...spec.consumes },
    refineryEff: spec.refineryEff, blackMarket: spec.blackMarket, seed,
  };
}

// ---------------------------------------------------------------------------
// Deterministic asteroid placement: rock i of a field is always the same rock
// (position, size, type) on every client and the server. Only hp/yield state
// is dynamic.
// ---------------------------------------------------------------------------

export interface RockSpawn {
  pos: Vec3;
  radius: number;
  type: RockType;
  spinSeed: number;
  // glowing mineral seams: surface directions where the good ore lives
  hotspots: Vec3[];
}

export function rockSpawn(field: FieldDef, belt: BeltDef, index: number): RockSpawn {
  const rng = new Rng((field.seed ^ (index * 2654435761)) >>> 0);
  // Distribute in a flattened ellipsoid cluster
  const a = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(rng.next()) * field.radius;
  const pos = v3(
    field.pos.x + Math.cos(a) * r,
    field.pos.y + rng.range(-0.25, 0.25) * field.radius,
    field.pos.z + Math.sin(a) * r,
  );
  const types = Object.keys(belt.composition) as RockType[];
  const weights = types.map((t) => belt.composition[t]);
  const type = rng.pickWeighted(types, weights);
  // rare rocks are smaller; big rocks are rarer (power distribution)
  const sizeRoll = Math.pow(rng.next(), 2.2);
  const radius = type === 'rare' ? 18 + sizeRoll * 60 : 25 + sizeRoll * 175;
  const hotspots: Vec3[] = [];
  const nSpots = rng.int(1, 3);
  for (let h = 0; h < nSpots; h++) {
    const az = rng.range(0, Math.PI * 2);
    const el = rng.range(-1, 1);
    const c = Math.sqrt(1 - el * el);
    hotspots.push(v3(Math.cos(az) * c, el, Math.sin(az) * c));
  }
  return { pos, radius, type, spinSeed: rng.int(1, 1e9), hotspots };
}

// Buying nav intel on an unvisited station: base fee + range surcharge.
export function stationInfoCost(from: Vec3, st: StationDef): number {
  const d = Math.hypot(st.pos.x - from.x, st.pos.y - from.y, st.pos.z - from.z);
  return Math.round((500 + (d / 1e6) * 35) / 10) * 10;
}

// Danger level (0..1) at a world position: belts/fields project danger near
// them, Rusthaven has a hot zone, deep void has a low floor. Drives pirate
// spawns and cruise interdiction odds.
export function dangerAt(system: SystemDef, pos: Vec3): number {
  let danger = 0.04; // the void is never fully safe
  for (const belt of system.belts) {
    for (const field of belt.fields) {
      const d = Math.hypot(pos.x - field.pos.x, pos.y - field.pos.y, pos.z - field.pos.z);
      if (d < field.radius * 4) danger = Math.max(danger, field.danger * (1 - d / (field.radius * 4) * 0.5));
    }
    // proximity to the belt ring itself (even between fields) — crossing a
    // belt lane is never free
    const ringDist = Math.abs(Math.hypot(pos.x, pos.z) - belt.ringRadius);
    if (ringDist < 2e6) danger = Math.max(danger, belt.danger * 0.5);
  }
  const rust = system.stations.find((s) => s.blackMarket);
  if (rust) {
    const d = Math.hypot(pos.x - rust.pos.x, pos.y - rust.pos.y, pos.z - rust.pos.z);
    if (d < 4e6 && d > rust.safeRadius) danger = Math.max(danger, 0.6 * (1 - d / 4e6));
  }
  // legal station police zones are safe
  for (const st of system.stations) {
    if (st.blackMarket) continue;
    const d = Math.hypot(pos.x - st.pos.x, pos.y - st.pos.y, pos.z - st.pos.z);
    if (d < st.safeRadius * 2.5) danger = Math.min(danger, Math.max(0, (d / (st.safeRadius * 2.5) - 0.4)) * 0.1);
  }
  return Math.min(1, Math.max(0, danger));
}
