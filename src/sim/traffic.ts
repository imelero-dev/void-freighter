// AI-LIFE: ambient non-hostile traffic that makes the simulated economy
// visible. Super-freighters and haulers ride real trade lanes (computed from
// station produce/consume relationships) and actually move stock when they
// complete a run; police patrols hunt pirates; couriers dart between ports;
// wandering merchants sell scarce goods in the void; and sometimes a MAYDAY
// crackles in — a civilian under pirate fire you can choose to save.
//
// Optimized as a player-centric bubble: traffic exists only near players,
// despawns far away (completing its route "off-screen"), hard caps keep the
// entity count flat.

import {
  DISTRESS_REWARD_MAX, DISTRESS_REWARD_MIN, GOODS, MERCHANT_HAIL_RANGE,
  MERCHANT_SELL_FACTOR, NPC_DEFS, modulePrice,
} from './data';
import type { Sim } from './sim';
import type { Entity, ModuleSlot, NpcKind, StationDef } from './types';
import {
  angleBetween, leadPoint, qForward, qLookAt, v3, vadd, vclone, vdist, vlen, vnorm, vscale, vsub,
  type Vec3,
} from './vec';
import { BOLT_SPEED } from './data';

const BUBBLE_RADIUS = 30_000;       // npcs counted "near" a player
const DESPAWN_RADIUS = 42_000;
const TRAFFIC_CAP_NEAR_PLAYER = 3;
const SPAWN_CHECK_S = 14;
const LANE_NEAR = 120_000;          // m from a lane segment to count as "on lane"
const STATION_NEAR = 60_000;
const ARRIVE_DIST = 2_600;
const STOCK_TRANSFER_MIN = 4;
const STOCK_TRANSFER_MAX = 10;
const MERCHANT_TIMER_S: [number, number] = [140, 300];
const DISTRESS_TIMER_S: [number, number] = [260, 460];
const PATROL_SCAN_RANGE = 8_000;
const PATROL_LEASH = 14_000;

const SHIP_NAMES_A = ['Bren', 'Vesper', 'Iron', 'Long', 'Dust', 'Pale', 'Far', 'Slow', 'Lucky', 'Grim', 'Old', 'Red'];
const SHIP_NAMES_B = ['Wager', 'Mule', 'Daughter', 'Promise', 'Furrow', 'Lantern', 'Ledger', 'Crossing', 'Harvest', 'Debt', 'Mercy', 'Round'];

const MERCHANT_LINES = [
  'Spare parts, rare pours, no receipts. Come alongside, pilot.',
  'You look like someone who needs what customs would not approve.',
  'Everything priced to move. The void is a terrible warehouse.',
];

const DISTRESS_LINES = [
  'MAYDAY MAYDAY — freight vessel under fire, they are cutting through my hull—',
  'Any ship, any ship — Scrappers on me, shields gone, please—',
  'This is a civilian transport! We are unarmed! Somebody—',
];

interface Lane {
  from: StationDef;
  to: StationDef;
  good: string;
}

interface MerchantStock {
  name: string;
  wares: Array<{ good: string; qty: number; price: number }>;
  module: { slot: ModuleSlot; tier: number; price: number } | null;
}

export class TrafficSystem {
  private lanes: Lane[] = [];
  private spawnAcc = new Map<number, number>();      // pid -> seconds to next check
  private merchantAcc = new Map<number, number>();   // pid -> deep-space merchant timer
  private distressAcc = new Map<number, number>();
  private merchants = new Map<number, MerchantStock>();
  private distress = new Map<number, { pirates: Set<number>; pid: number }>();

  constructor(private sim: Sim) {
    // trade lanes: every producer -> consumer relationship becomes a route
    for (const a of sim.system.stations) {
      for (const b of sim.system.stations) {
        if (a.id === b.id) continue;
        for (const good of Object.keys(a.produces)) {
          if ((b.consumes[good] ?? 0) > 0) {
            this.lanes.push({ from: a, to: b, good });
            break; // one lane per pair is enough
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------

  tick(dt: number, secondTick: boolean): void {
    const sim = this.sim;
    if (secondTick) {
      for (const meta of sim.players.values()) {
        const e = sim.entities.get(meta.pid);
        if (!e || e.dead || e.dockedAt) continue;
        const acc = (this.spawnAcc.get(meta.pid) ?? sim.rng.range(0, SPAWN_CHECK_S)) - 1;
        if (acc <= 0) {
          this.spawnAcc.set(meta.pid, SPAWN_CHECK_S);
          this.maybeSpawnTraffic(e);
        } else {
          this.spawnAcc.set(meta.pid, acc);
        }
        // deep-space specials
        const mAcc = (this.merchantAcc.get(meta.pid) ?? sim.rng.range(60, 160)) - 1;
        if (mAcc <= 0) {
          this.merchantAcc.set(meta.pid, sim.rng.range(...MERCHANT_TIMER_S));
          this.maybeSpawnMerchant(e);
        } else {
          this.merchantAcc.set(meta.pid, mAcc);
        }
        const dAcc = (this.distressAcc.get(meta.pid) ?? sim.rng.range(120, 240)) - 1;
        if (dAcc <= 0) {
          this.distressAcc.set(meta.pid, sim.rng.range(...DISTRESS_TIMER_S));
          if (sim.rng.chance(0.55)) this.spawnDistress(e, meta.pid);
        } else {
          this.distressAcc.set(meta.pid, dAcc);
        }
      }
    }
  }

  // Per-entity AI (called from the Sim entity loop)
  tickNpc(e: Entity, dt: number): void {
    const sim = this.sim;
    const def = NPC_DEFS[e.npc!];

    // despawn far from every player — completing the route off-screen
    let nearestD = Infinity;
    for (const meta of sim.players.values()) {
      const p = sim.entities.get(meta.pid);
      if (!p || p.dead) continue;
      const d = vdist(p.pos, e.pos);
      if (d < nearestD) nearestD = d;
    }
    if (nearestD > DESPAWN_RADIUS) {
      this.completeRoute(e);
      this.cleanup(e.id);
      sim.entities.delete(e.id);
      return;
    }

    e.aiTimer -= dt;
    switch (e.npc) {
      case 'patrol':
        this.tickPatrol(e, def, dt);
        break;
      case 'merchant':
        this.tickMerchant(e, def, dt);
        break;
      default:
        this.tickHauler(e, def, dt);
        break;
    }
  }

  // ---- haulers / couriers / superfreighters: ride the lane ----

  private tickHauler(e: Entity, def: (typeof NPC_DEFS)['freighter'], dt: number): void {
    const sim = this.sim;
    if (e.aiState === 'flee') {
      // evade: under fire you cannot hold lane speed — bank away on raw
      // engines with jink (slow enough that pirates CAN run them down)
      const threat = e.aggroId !== null ? sim.entities.get(e.aggroId) : null;
      const away = threat ? vnorm(vsub(e.pos, threat.pos)) : qForward(e.orient);
      const jink = v3(Math.sin(sim.time * 2.1 + e.id) * 0.3, Math.sin(sim.time * 1.7 + e.id) * 0.2, Math.cos(sim.time * 1.9 + e.id) * 0.3);
      const dir = vnorm(vadd(away, jink));
      e.orient = qLookAt(dir);
      e.vel = vscale(dir, def.maxSpeed * 1.15);
      if (e.aiTimer <= 0 || !threat || threat.dead) e.aiState = 'approach';
    } else {
      const dest = sim.station(e.fieldId ?? '');
      const target = dest ? dest.pos : vadd(e.pos, vscale(qForward(e.orient), 10_000));
      const dir = vnorm(vsub(target, e.pos));
      e.orient = qLookAt(dir);
      // approach braking: lane speed in the open, engine speed near the port
      let speed = def.laneSpeed;
      if (dest) {
        const d = vdist(e.pos, dest.pos);
        if (d < 12_000) speed = Math.max(def.maxSpeed, d / 18);
      }
      e.vel = vscale(dir, speed);
      if (dest && vdist(e.pos, dest.pos) < ARRIVE_DIST + dest.radius) {
        this.completeRoute(e);
        this.cleanup(e.id);
        sim.entities.delete(e.id);
        return;
      }
    }
    e.pos = vadd(e.pos, vscale(e.vel, dt));
  }

  // ---- police patrols: loiter, then hunt pirates (or player aggressors) ----

  private tickPatrol(e: Entity, def: (typeof NPC_DEFS)['patrol'], dt: number): void {
    const sim = this.sim;
    const target = e.aggroId !== null ? sim.entities.get(e.aggroId) : null;
    const targetGone = !target || target.dead || target.dockedAt
      || vdist(target.pos, e.spawnPos) > PATROL_LEASH * 1.6;

    if (e.aiState === 'attack' && !targetGone) {
      const d = vdist(target!.pos, e.pos);
      const aim = leadPoint(e.pos, e.vel, target!.pos, target!.vel, BOLT_SPEED);
      this.steer(e, aim, def, d > 600 ? 1 : 0.4, dt);
      const ang = angleBetween(qForward(e.orient), vsub(aim, e.pos));
      e.targetId = target!.id;
      e.firing = d < def.weaponRange && ang < 0.13;
    } else {
      e.firing = false;
      e.aggroId = null;
      e.aiState = 'patrol';
      // lazy loop around the beat
      const t = sim.time * 0.05 + e.id * 2.1;
      const wander = vadd(e.spawnPos, v3(Math.sin(t) * 3200, Math.sin(t * 0.7) * 800, Math.cos(t) * 3200));
      this.steer(e, wander, def, 0.45, dt);
      // scan for pirates working this beat
      for (const h of sim.entities.values()) {
        if (h.kind !== 'ship' || !h.pirate || h.pirate === 'turret' || h.dead) continue;
        if (vdist(h.pos, e.pos) < PATROL_SCAN_RANGE) {
          e.aggroId = h.id;
          e.aiState = 'attack';
          sim.emit({ type: 'chat', from: e.name, text: 'Pirate signature confirmed. Weapons free.', channel: 'local', pid: undefined });
          break;
        }
      }
    }
    e.pos = vadd(e.pos, vscale(e.vel, dt));
  }

  // ---- wandering merchants: drift and wait for customers ----

  private tickMerchant(e: Entity, def: (typeof NPC_DEFS)['merchant'], dt: number): void {
    const sim = this.sim;
    if (e.aiState === 'flee') {
      this.tickHauler(e, def, dt); // borrow the evade logic
      return;
    }
    // slow drift + slow roll: a shop with engines
    const t = sim.time * 0.02 + e.id;
    e.vel = v3(Math.sin(t) * 6, Math.sin(t * 0.6) * 2, Math.cos(t) * 6);
    e.orient = qLookAt(vnorm(v3(Math.sin(t * 0.3), 0.05, Math.cos(t * 0.3))));
    e.pos = vadd(e.pos, vscale(e.vel, dt));
    // greet approaching players (once per merchant)
    if (e.aiTimer <= 0) {
      for (const meta of sim.players.values()) {
        const p = sim.entities.get(meta.pid);
        if (!p || p.dead || p.dockedAt) continue;
        if (vdist(p.pos, e.pos) < MERCHANT_HAIL_RANGE * 2.2) {
          e.aiTimer = 600; // do not spam
          sim.emit({ type: 'comms', pid: meta.pid, text: `${e.name}: ${sim.rng.pick(MERCHANT_LINES)}` });
          sim.emit({ type: 'log', text: `Trader in range — target it and press [U] to hail.`, color: '#d8c46a', pid: meta.pid });
          break;
        }
      }
    }
  }

  private steer(e: Entity, point: Vec3, def: { maxSpeed: number; accel: number; turnRate: number }, throttle: number, dt: number): void {
    const desired = qLookAt(vnorm(vsub(point, e.pos)));
    e.orient = rotateTowardsQ(e.orient, desired, def.turnRate * dt);
    const want = vscale(qForward(e.orient), def.maxSpeed * throttle);
    const delta = vsub(want, e.vel);
    const dl = vlen(delta);
    if (dl > 1e-6) {
      const f = Math.min(1, (def.accel * dt) / dl);
      e.vel = vadd(e.vel, vscale(delta, f));
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private bubbleCount(pos: Vec3): number {
    let n = 0;
    for (const e of this.sim.entities.values()) {
      if (e.kind === 'ship' && e.npc && vdist(e.pos, pos) < BUBBLE_RADIUS) n++;
    }
    return n;
  }

  private maybeSpawnTraffic(player: Entity): void {
    const sim = this.sim;
    const population = this.bubbleCount(player.pos);
    if (population >= TRAFFIC_CAP_NEAR_PLAYER) return;

    // context: near a station? near a lane?
    const nearStation = sim.system.stations.find((s) => vdist(s.pos, player.pos) < STATION_NEAR);
    const lane = this.laneNear(player.pos);
    if (!nearStation && !lane) return;
    if (!sim.rng.chance(0.4)) return;

    // first impression: an empty port fills up fast
    const burst = population === 0 && nearStation ? 2 : 1;
    for (let i = 0; i < burst; i++) {
      if (nearStation) {
        // local port traffic: couriers and freighters arriving/leaving, the
        // occasional patrol on its beat
        const roll = sim.rng.next();
        if (roll < 0.22) {
          this.spawnPatrol(vadd(nearStation.pos, randOffset(sim, 3000, 7000)), nearStation.factionId);
        } else {
          const kind: NpcKind = roll < 0.6 ? 'courier' : 'freighter';
          const outbound = sim.rng.chance(0.5);
          const other = sim.rng.pick(sim.system.stations.filter((s) => s.id !== nearStation.id));
          const from = outbound ? nearStation : other;
          const to = outbound ? other : nearStation;
          const pos = outbound
            ? vadd(nearStation.pos, randOffset(sim, 2500, 5500))
            : vadd(player.pos, randOffset(sim, 4000, 8000));
          const h = this.spawnHauler(kind, pos, from, to);
          // port chatter: traffic you can hear, not just see
          if (sim.rng.chance(0.35)) {
            for (const meta of sim.players.values()) {
              const p = sim.entities.get(meta.pid);
              if (p && !p.dockedAt && vdist(p.pos, h.pos) < 15_000) {
                sim.emit({
                  type: 'comms', pid: meta.pid,
                  text: outbound
                    ? `${h.name}: ${nearStation.name} control, requesting departure corridor. Hold is full, mood is better.`
                    : `${h.name}: ${nearStation.name} control, inbound on final. Try not to scratch the paint this time.`,
                });
                break;
              }
            }
          }
        }
      } else if (lane) {
        // lane traffic passing through the bubble
        const kind: NpcKind = sim.rng.chance(0.12) ? 'superfreighter' : sim.rng.chance(0.55) ? 'freighter' : 'courier';
        const dir = vnorm(vsub(lane.to.pos, lane.from.pos));
        // drop it upstream of the player so it sails past, close enough to see
        const behind = sim.rng.range(4000, 9000);
        const lateral = randOffset(sim, 500, 1600);
        const pos = vadd(vadd(player.pos, vscale(dir, -behind)), lateral);
        this.spawnHauler(kind, pos, lane.from, lane.to, lane.good);
      }
    }
  }

  private maybeSpawnMerchant(player: Entity): void {
    const sim = this.sim;
    // deep space only, away from ports
    for (const st of sim.system.stations) {
      if (vdist(player.pos, st.pos) < STATION_NEAR) return;
    }
    if (player.cruise === 'cruise') return;
    if (!sim.rng.chance(0.5)) return;
    const e = this.spawnNpc('merchant', vadd(player.pos, randOffset(sim, 4000, 8000)), 'drift');
    e.name = `"${sim.rng.pick(SHIP_NAMES_A)} ${sim.rng.pick(SHIP_NAMES_B)}" (trader)`;
  }

  // public so dev tools/tests can stage a rescue
  spawnDistress(player: Entity, pid: number): void {
    const sim = this.sim;
    for (const st of sim.system.stations) {
      if (vdist(player.pos, st.pos) < st.safeRadius * 1.5) return;
    }
    if (player.cruise === 'cruise') return;
    const sitePos = vadd(player.pos, randOffset(sim, 6000, 9000));
    const kind: NpcKind = sim.rng.chance(0.6) ? 'freighter' : 'courier';
    const civ = this.spawnNpc(kind, sitePos, 'independent');
    civ.name = `"${sim.rng.pick(SHIP_NAMES_A)} ${sim.rng.pick(SHIP_NAMES_B)}"`;
    civ.fieldId = sim.nearestStation(sitePos).id; // it will run for port if it survives
    civ.aiState = 'flee';
    civ.aiTimer = 999;
    const n = sim.rng.int(1, 2);
    const pirates = new Set<number>();
    for (let i = 0; i < n; i++) {
      const pirate = sim.spawnPirate(sim.rng.chance(0.7) ? 'fighter' : 'scout', vadd(sitePos, randOffset(sim, 600, 1400)));
      pirate.aggroId = civ.id;
      pirate.aiState = 'attack';
      pirates.add(pirate.id);
      civ.aggroId = pirate.id;
    }
    this.distress.set(civ.id, { pirates, pid });
    sim.emit({ type: 'comms', pid, text: sim.rng.pick(DISTRESS_LINES) });
    sim.emit({ type: 'distress', pid, entityId: civ.id, text: 'Civilian distress call — signature marked on scanner.' });
    sim.emit({ type: 'log', text: 'MAYDAY received — a civilian is under attack nearby.', color: '#e8402a', pid });
  }

  // ---- spawn helpers ----

  private spawnHauler(kind: NpcKind, pos: Vec3, from: StationDef, to: StationDef, good?: string): Entity {
    const sim = this.sim;
    const e = this.spawnNpc(kind, pos, from.factionId);
    e.fieldId = to.id; // destination station rides in fieldId (unused for ships)
    e.goodId = good ?? Object.keys(from.produces)[0] ?? null;
    e.name = kind === 'superfreighter'
      ? `BHC "${sim.rng.pick(SHIP_NAMES_A)} ${sim.rng.pick(SHIP_NAMES_B)}" (bulk carrier)`
      : `"${sim.rng.pick(SHIP_NAMES_A)} ${sim.rng.pick(SHIP_NAMES_B)}"`;
    const dir = vnorm(vsub(to.pos, e.pos));
    e.orient = qLookAt(dir);
    e.vel = vscale(dir, NPC_DEFS[kind].laneSpeed);
    e.aiState = 'approach';
    return e;
  }

  private spawnPatrol(pos: Vec3, factionId: string): Entity {
    const sim = this.sim;
    const e = this.spawnNpc('patrol', pos, factionId);
    const faction = sim.system.factions.find((f) => f.id === factionId);
    e.name = `${faction?.name ?? 'System'} Patrol`;
    e.spawnPos = vclone(pos);
    e.aiState = 'patrol';
    return e;
  }

  private spawnNpc(kind: NpcKind, pos: Vec3, factionId: string): Entity {
    const sim = this.sim;
    const def = NPC_DEFS[kind];
    const e = sim.spawnShipEntity();
    e.npc = kind;
    e.factionId = factionId;
    e.hullId = kind === 'superfreighter' || kind === 'freighter' ? (kind === 'superfreighter' ? 'freighter' : 'hauler')
      : kind === 'courier' ? 'shuttle' : kind === 'patrol' ? 'interceptor' : 'prospector';
    e.radius = def.radius;
    e.maxHull = def.hull;
    e.hull = def.hull;
    e.maxShield = def.shield;
    e.shield = def.shield;
    e.pos = vclone(pos);
    e.prevPos = vclone(pos);
    e.aiTimer = 0;
    return e;
  }

  // ---- route completion: the economy actually moves ----

  private completeRoute(e: Entity): void {
    const sim = this.sim;
    if (!e.npc || e.npc === 'patrol' || e.npc === 'merchant') return;
    const dest = sim.station(e.fieldId ?? '');
    if (!dest || !e.goodId) return;
    const qty = sim.rng.int(STOCK_TRANSFER_MIN, STOCK_TRANSFER_MAX) * (e.npc === 'superfreighter' ? 4 : 1);
    const destStock = sim.economy.stocks.get(dest.id);
    if (destStock && destStock[e.goodId] !== undefined) {
      destStock[e.goodId] += qty;
    }
  }

  // -------------------------------------------------------------------------
  // Combat reactions (called from Sim.applyDamage / handleDeath)
  // -------------------------------------------------------------------------

  onNpcDamaged(e: Entity, sourceId: number): void {
    const sim = this.sim;
    const source = sim.entities.get(sourceId);
    if (!source) return;
    // civilians run and scream
    if (e.npc !== 'patrol' && e.aiState !== 'flee') {
      e.aiState = 'flee';
      e.aiTimer = 14;
      e.aggroId = sourceId;
      for (const meta of sim.players.values()) {
        const p = sim.entities.get(meta.pid);
        if (p && !p.dockedAt && vdist(p.pos, e.pos) < 20_000) {
          sim.emit({ type: 'comms', pid: meta.pid, text: `${e.name}: ${sim.rng.pick(DISTRESS_LINES)}` });
        }
      }
    }
    // patrols answer violence — whoever started it
    for (const cop of sim.entities.values()) {
      if (cop.kind !== 'ship' || cop.npc !== 'patrol' || cop.dead || cop.id === e.id) continue;
      if (vdist(cop.pos, e.pos) < 11_000 && cop.aiState !== 'attack') {
        cop.aggroId = sourceId;
        cop.aiState = 'attack';
      }
    }
    // shooting the police is its own crime
    if (e.npc === 'patrol' && source.isPlayer) {
      e.aggroId = sourceId;
      e.aiState = 'attack';
    }
  }

  onNpcKilled(e: Entity, killerId: number): void {
    const sim = this.sim;
    const killer = sim.entities.get(killerId);
    this.cleanup(e.id);
    if (killer?.isPlayer && e.npc !== 'patrol') {
      const meta = sim.players.get(killerId);
      if (meta) {
        sim.addRep(meta.profile, e.factionId === 'scrappers' ? 'drift' : e.factionId, -4);
        sim.emit({ type: 'log', text: 'You destroyed a civilian vessel. Word travels.', color: '#e8402a', pid: killerId });
      }
    }
    const d = this.distress.get(e.id);
    if (d) {
      this.distress.delete(e.id);
      sim.emit({ type: 'log', text: 'The civilian ship did not make it.', color: '#8a8d90', pid: d.pid });
    }
  }

  // called when any pirate dies — settles distress rescues
  onPirateKilled(pirateId: number, killerId: number): void {
    const sim = this.sim;
    for (const [civId, group] of this.distress) {
      if (!group.pirates.has(pirateId)) continue;
      group.pirates.delete(pirateId);
      const civ = sim.entities.get(civId);
      if (group.pirates.size === 0) {
        this.distress.delete(civId);
        const killer = sim.entities.get(killerId);
        if (killer?.isPlayer && civ && !civ.dead) {
          const meta = sim.players.get(killerId);
          if (meta) {
            const reward = sim.rng.int(DISTRESS_REWARD_MIN, DISTRESS_REWARD_MAX);
            meta.profile.credits += reward;
            meta.profile.stats.creditsEarned += reward;
            sim.addRep(meta.profile, civ.factionId === 'scrappers' ? 'drift' : civ.factionId, 2);
            sim.emit({ type: 'comms', pid: killerId, text: `${civ.name}: I owe you my hide, pilot. Transferring what I can spare.` });
            sim.emit({ type: 'log', text: `Rescue reward: +${reward} cr.`, color: '#7fc97f', pid: killerId });
            civ.aiState = 'approach'; // resume its run
            civ.aggroId = null;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Merchant trading
  // -------------------------------------------------------------------------

  hailMerchant(pid: number, merchantId: number): void {
    const sim = this.sim;
    const meta = sim.players.get(pid);
    const p = sim.entities.get(pid);
    const m = sim.entities.get(merchantId);
    if (!meta || !p || !m || m.npc !== 'merchant' || m.dead) return;
    if (vdist(p.pos, m.pos) > MERCHANT_HAIL_RANGE) {
      sim.emit({ type: 'log', text: 'Too far to hail — close within 900 m.', color: '#fa4', pid });
      return;
    }
    const stock = this.merchantStock(m);
    sim.emit({
      type: 'merchant', pid, entityId: merchantId, name: m.name,
      wares: stock.wares.map((w) => ({ ...w })), module: stock.module ? { ...stock.module } : null,
    });
  }

  private merchantStock(m: Entity): MerchantStock {
    let stock = this.merchants.get(m.id);
    if (stock) return stock;
    const sim = this.sim;
    const rng = sim.rng;
    const pool = ['medicine', 'components', 'adv_alloys', 'fuel_cells', 'machinery', 'consumer_goods', 'iridium', 'repair_kit', 'stims', 'small_arms'];
    const count = rng.int(4, 7);
    const wares: MerchantStock['wares'] = [];
    const used = new Set<string>();
    for (let i = 0; i < count; i++) {
      const good = rng.pick(pool);
      if (used.has(good)) continue;
      used.add(good);
      wares.push({
        good,
        qty: rng.int(3, 14),
        price: Math.round(GOODS[good].basePrice * rng.range(1.25, 1.8)),
      });
    }
    // the occasional gem: a module under market price, or a steal of a deal
    let module: MerchantStock['module'] = null;
    if (rng.chance(0.3)) {
      const slots: ModuleSlot[] = ['shield', 'engine', 'weapon', 'scanner', 'drill', 'collector'];
      const slot = rng.pick(slots);
      const tier = rng.int(2, 4);
      module = { slot, tier, price: Math.round(modulePrice(slot, tier) * 0.7) };
    } else if (wares.length > 0 && rng.chance(0.4)) {
      const gem = rng.pick(wares);
      gem.price = Math.round(GOODS[gem.good].basePrice * 0.6);
    }
    stock = { name: m.name, wares, module };
    this.merchants.set(m.id, stock);
    return stock;
  }

  merchantBuy(pid: number, merchantId: number, goodId: string, qty: number): void {
    const sim = this.sim;
    const meta = sim.players.get(pid);
    const p = sim.entities.get(pid);
    const m = sim.entities.get(merchantId);
    if (!meta || !p || !m || m.npc !== 'merchant' || qty <= 0 || !Number.isFinite(qty)) return;
    if (vdist(p.pos, m.pos) > MERCHANT_HAIL_RANGE) return;
    qty = Math.floor(qty);
    const stock = this.merchantStock(m);
    const ware = stock.wares.find((w) => w.good === goodId);
    if (!ware || ware.qty < qty) return;
    const cost = ware.price * qty;
    if (meta.profile.credits < cost) {
      sim.emit({ type: 'log', text: 'Not enough credits.', color: '#f66', pid });
      return;
    }
    if (sim.cargoFree(pid) < GOODS[goodId].volume * qty) {
      sim.emit({ type: 'log', text: 'Not enough cargo space.', color: '#f66', pid });
      return;
    }
    meta.profile.credits -= cost;
    ware.qty -= qty;
    stock.wares = stock.wares.filter((w) => w.qty > 0);
    sim.addCargo(meta.profile, goodId, qty);
    meta.profile.stats.unitsTraded += qty;
    sim.emit({ type: 'tx', pid, good: goodId, qty, total: cost, bought: true });
  }

  merchantBuyModule(pid: number, merchantId: number): void {
    const sim = this.sim;
    const meta = sim.players.get(pid);
    const p = sim.entities.get(pid);
    const m = sim.entities.get(merchantId);
    if (!meta || !p || !m || m.npc !== 'merchant') return;
    if (vdist(p.pos, m.pos) > MERCHANT_HAIL_RANGE) return;
    const stock = this.merchantStock(m);
    if (!stock.module) return;
    if (meta.profile.credits < stock.module.price) {
      sim.emit({ type: 'log', text: 'Not enough credits.', color: '#f66', pid });
      return;
    }
    meta.profile.credits -= stock.module.price;
    meta.profile.moduleStash.push({ slot: stock.module.slot, tier: stock.module.tier });
    sim.emit({ type: 'log', text: `Bought a salvaged module — check your stash at a shipyard.`, color: '#7fc97f', pid });
    stock.module = null;
  }

  merchantSell(pid: number, merchantId: number, goodId: string, qty: number): void {
    const sim = this.sim;
    const meta = sim.players.get(pid);
    const p = sim.entities.get(pid);
    const m = sim.entities.get(merchantId);
    if (!meta || !p || !m || m.npc !== 'merchant' || qty <= 0 || !Number.isFinite(qty)) return;
    if (vdist(p.pos, m.pos) > MERCHANT_HAIL_RANGE) return;
    qty = Math.floor(qty);
    if (sim.freeQty(meta.profile, goodId) < qty || !GOODS[goodId]) return;
    sim.removeCargo(meta.profile, goodId, qty);
    const proceeds = Math.round(GOODS[goodId].basePrice * MERCHANT_SELL_FACTOR * qty);
    meta.profile.credits += proceeds;
    meta.profile.stats.creditsEarned += proceeds;
    meta.profile.stats.unitsTraded += qty;
    sim.emit({ type: 'tx', pid, good: goodId, qty, total: proceeds, bought: false });
  }

  // -------------------------------------------------------------------------

  private laneNear(pos: Vec3): Lane | null {
    for (const lane of this.lanes) {
      if (pointSegmentDist(pos, lane.from.pos, lane.to.pos) < LANE_NEAR) return lane;
    }
    return null;
  }

  private cleanup(id: number): void {
    this.merchants.delete(id);
    this.distress.delete(id);
  }
}

// ---------------------------------------------------------------------------

function randOffset(sim: { rng: { range(a: number, b: number): number } }, min: number, max: number): Vec3 {
  const r = sim.rng.range(min, max);
  const a = sim.rng.range(0, Math.PI * 2);
  const y = sim.rng.range(-0.25, 0.25) * r;
  return v3(Math.cos(a) * r, y, Math.sin(a) * r);
}

function pointSegmentDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = vsub(b, a);
  const ap = vsub(p, a);
  const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / len2)) : 0;
  const c = vadd(a, vscale(ab, t));
  return vdist(p, c);
}

function rotateTowardsQ(a: Entity['orient'], b: Entity['orient'], maxAngle: number): Entity['orient'] {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bb = b;
  if (dot < 0) {
    bb = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    dot = -dot;
  }
  const angle = 2 * Math.acos(Math.min(1, dot));
  if (angle < 1e-5 || angle <= maxAngle) return { ...bb };
  const t = maxAngle / angle;
  const q = {
    x: a.x + (bb.x - a.x) * t,
    y: a.y + (bb.y - a.y) * t,
    z: a.z + (bb.z - a.z) * t,
    w: a.w + (bb.w - a.w) * t,
  };
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
