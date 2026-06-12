// Procedural contract boards. Each station regenerates a board of offers on a
// timer; accepting moves a contract into the player profile. Deterministic.

import { GOODS, PIRATES, REP_CONTRACT_GATE_T2, REP_CONTRACT_GATE_T3 } from './data';
import { Rng } from './rng';
import { dangerAt } from './system';
import type { Contract, ContractType, StationDef, SystemDef } from './types';
import { dist } from './types';

export const BOARD_REFRESH_S = 240;
const AVG_CRUISE_SPEED = 180_000; // m/s, for deadline estimates

export class ContractBoards {
  boards = new Map<string, Contract[]>();
  private rng: Rng;
  private nextRefresh = 0;
  private counter = 1;

  constructor(private system: SystemDef) {
    this.rng = new Rng(system.seed ^ 0xc0ffee);
  }

  tick(time: number): void {
    if (time < this.nextRefresh) return;
    this.nextRefresh = time + BOARD_REFRESH_S;
    for (const st of this.system.stations) {
      this.boards.set(st.id, this.generateBoard(st, time));
    }
  }

  boardFor(stationId: string): Contract[] {
    return this.boards.get(stationId) ?? [];
  }

  take(stationId: string, contractId: string): Contract | null {
    const board = this.boards.get(stationId);
    if (!board) return null;
    const i = board.findIndex((c) => c.id === contractId);
    if (i === -1) return null;
    const [c] = board.splice(i, 1);
    c.accepted = true;
    return c;
  }

  // Reputation tier required to accept (0 / T2 / T3 by reward size).
  // Rewards scale with distance, so the gates sit well above a rookie's
  // short-haul range — every board also guarantees ungated local runs.
  static repRequired(c: Contract): number {
    if (c.reward >= 3500) return REP_CONTRACT_GATE_T3;
    if (c.reward >= 1800) return REP_CONTRACT_GATE_T2;
    return -100;
  }

  private generateBoard(st: StationDef, time: number): Contract[] {
    const rng = this.rng;
    const count = st.services.includes('shipyard') ? 8 : 6;
    const out: Contract[] = [];
    for (let i = 0; i < count; i++) {
      // the first two offers are always rookie-friendly local hauls
      const type = i < 2 ? 'transport' : rng.pickWeighted(
        ['transport', 'urgent', 'supply', 'bounty'] as ContractType[],
        [4, 2, st.services.includes('refinery') ? 2.5 : 1.5, 2]);
      const c = this.generate(st, type, time, rng, i < 2);
      if (c) out.push(c);
    }
    return out;
  }

  private generate(st: StationDef, type: ContractType, time: number, rng: Rng, localRun = false): Contract | null {
    const id = `c${this.counter++}_${Math.floor(rng.next() * 1e6)}`;
    switch (type) {
      case 'transport':
      case 'urgent': {
        let candidates = this.system.stations.filter((s) => s.id !== st.id);
        if (localRun) {
          candidates = [...candidates]
            .sort((a, b) => dist(st.pos, a.pos) - dist(st.pos, b.pos))
            .slice(0, 3);
        }
        const dest = rng.pick(candidates);
        // black market boards offer smuggling runs (illegal goods, fat pay)
        const pool = st.blackMarket && rng.chance(0.5)
          ? ['stims', 'small_arms', 'artifacts']
          : ['food', 'medicine', 'textiles', 'machinery', 'components', 'consumer_goods', 'ship_parts', 'water', 'fuel_cells', 'steel'];
        const goodId = rng.pick(pool);
        const def = GOODS[goodId];
        // small offers must fit a starter hold; big ones pay for a hauler
        const big = !localRun && rng.chance(0.3);
        const qty = big ? rng.int(40, 110) : rng.int(6, 16);
        const d = dist(st.pos, dest.pos);
        const travel = d / AVG_CRUISE_SPEED + 150;
        const danger = dangerAt(this.system, dest.pos);
        const value = def.basePrice * qty;
        let reward = 120 + (d / 1e6) * 55 + value * 0.18 + danger * 300;
        let deadline = time + travel * 3 + 600;
        if (type === 'urgent') {
          reward *= 1.55;
          deadline = time + travel * 1.5 + 200;
        }
        // smuggling runs pay big — the cargo can be confiscated at dock inspections
        if (!def.legal) reward *= 1.8;
        return {
          id, type, from: st.id, dest: dest.id, good: goodId, qty,
          killsRequired: 0, killsDone: 0, pirateZone: null,
          deadline: Math.round(deadline), reward: Math.round(reward),
          repReward: type === 'urgent' ? 3 : 2, factionId: st.factionId, accepted: false,
          desc: `Haul ${qty}× ${def.name} to ${this.stationName(dest.id)}${type === 'urgent' ? ' — priority freight' : ''}.`,
        };
      }
      case 'supply': {
        const pool = ['iron_ore', 'copper_ore', 'ice', 'silicates', 'volatiles', 'steel', 'water', 'iridium_ore'];
        const goodId = rng.pick(pool);
        const def = GOODS[goodId];
        const qty = goodId === 'iridium_ore' ? rng.int(8, 20) : rng.int(25, 70);
        const reward = Math.round(qty * def.basePrice * 0.5 + 250);
        return {
          id, type, from: st.id, dest: st.id, good: goodId, qty,
          killsRequired: 0, killsDone: 0, pirateZone: null,
          deadline: Math.round(time + 2400), reward, repReward: 2,
          factionId: st.factionId, accepted: false,
          desc: `Deliver ${qty}× ${def.name} to ${st.name} (mine it or buy it).`,
        };
      }
      case 'bounty': {
        // hunt in a nearby dangerous field
        const fields = this.system.belts.flatMap((b) => b.fields).filter((f) => f.danger > 0.1);
        if (fields.length === 0) return null;
        const weights = fields.map((f) => 1 / (1 + dist(st.pos, f.pos) / 1e7));
        const zone = rng.pickWeighted(fields, weights);
        const kills = rng.int(2, 5);
        const tierValue = zone.danger > 0.6 ? PIRATES.raider.bounty : zone.danger > 0.3 ? PIRATES.fighter.bounty : PIRATES.scout.bounty;
        const reward = Math.round(kills * tierValue * 1.15 + 150);
        return {
          id, type, from: st.id, dest: st.id, good: null, qty: 0,
          killsRequired: kills, killsDone: 0, pirateZone: zone.id,
          deadline: Math.round(time + 3000), reward, repReward: 3,
          factionId: st.factionId, accepted: false,
          desc: `Destroy ${kills} pirate ships in ${zone.name}.`,
        };
      }
    }
  }

  private stationName(id: string): string {
    return this.system.stations.find((s) => s.id === id)?.name ?? id;
  }
}
