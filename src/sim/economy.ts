// Market simulation: per-station stock, dynamic prices from supply/demand,
// player-order slippage, mean reversion and periodic economic events.
// Deterministic: all randomness flows through a seeded Rng.

import { GOODS, GOOD_IDS } from './data';
import { Rng, noise2 } from './rng';
import type { EconEvent, EconEventKind, MarketEntry, StationDef, SystemDef } from './types';

export const ECON_TICK_S = 5;
const REVERSION_RATE = 0.004;      // stock drift toward equilibrium per econ tick
const STOCK_CAP_FACTOR = 4;        // max stock = factor * target
const SPREAD = 0.04;               // half-spread between buy and sell price
const EVENT_MIN_GAP_S = 150;
const EVENT_MAX_GAP_S = 400;
const MAX_ACTIVE_EVENTS = 3;

export interface StationStocks {
  [goodId: string]: number;
}

export interface EconomySave {
  stocks: Record<string, StationStocks>;
  events: EconEvent[];
  nextEventAt: number;
  rngState: number;
}

export class Economy {
  stocks = new Map<string, StationStocks>();   // stationId -> goodId -> units
  targets = new Map<string, StationStocks>();  // equilibrium stock levels
  events: EconEvent[] = [];
  nextEventAt: number;
  private rng: Rng;
  private acc = 0;

  constructor(private system: SystemDef) {
    this.rng = new Rng(system.seed ^ 0x5eed);
    this.nextEventAt = 120 + this.rng.range(0, 120);
    for (const st of system.stations) {
      const target: StationStocks = {};
      const stock: StationStocks = {};
      for (const id of this.tradedGoods(st)) {
        const prod = st.produces[id] ?? 0;
        const cons = st.consumes[id] ?? 0;
        target[id] = Math.round(100 + prod * 40 + cons * 25);
        // producers start overstocked (cheap), consumers understocked (dear)
        const bias = prod > 0 ? 2.2 : cons > 0 ? 0.35 : 1;
        stock[id] = Math.round(target[id] * bias * this.rng.range(0.85, 1.15));
      }
      this.targets.set(st.id, target);
      this.stocks.set(st.id, stock);
    }
  }

  // Goods listed on a station's market. Illegal goods only at black markets.
  tradedGoods(st: StationDef): string[] {
    return GOOD_IDS.filter((id) => GOODS[id].legal || st.blackMarket);
  }

  tick(time: number, dt: number): EconEvent | null {
    this.acc += dt;
    if (this.acc < ECON_TICK_S) return null;
    this.acc -= ECON_TICK_S;

    for (const st of this.system.stations) {
      const stock = this.stocks.get(st.id)!;
      const target = this.targets.get(st.id)!;
      for (const id of Object.keys(stock)) {
        let s = stock[id];
        let prod = st.produces[id] ?? 0;
        let cons = st.consumes[id] ?? 0;
        for (const ev of this.events) {
          if (ev.stationId !== st.id || ev.goodId !== id) continue;
          if (ev.kind === 'shortage') cons *= 3;
          if (ev.kind === 'boom') cons *= 4;
          if (ev.kind === 'surplus') prod *= 3;
        }
        s += prod;
        s -= Math.min(cons, s);
        s += (target[id] - s) * REVERSION_RATE;
        stock[id] = Math.min(s, target[id] * STOCK_CAP_FACTOR);
      }
    }

    this.events = this.events.filter((e) => e.endsAt > time);
    if (time >= this.nextEventAt && this.events.length < MAX_ACTIVE_EVENTS) {
      this.nextEventAt = time + this.rng.range(EVENT_MIN_GAP_S, EVENT_MAX_GAP_S);
      return this.spawnEvent(time);
    }
    return null;
  }

  private spawnEvent(time: number): EconEvent | null {
    const st = this.rng.pick(this.system.stations);
    const kind: EconEventKind = this.rng.pickWeighted(
      ['shortage', 'surplus', 'blockade', 'boom'] as EconEventKind[], [4, 3, 2, 2]);
    const stock = this.stocks.get(st.id)!;
    const target = this.targets.get(st.id)!;
    let goodId: string;
    let priceMult = 1;
    let headline: string;
    switch (kind) {
      case 'shortage': {
        const candidates = Object.keys(st.consumes).filter((g) => stock[g] !== undefined);
        if (candidates.length === 0) return null;
        goodId = this.rng.pick(candidates);
        stock[goodId] = Math.max(0, stock[goodId] * 0.3);
        priceMult = 1.3;
        headline = `${GOODS[goodId].name} shortage reported at ${st.name} — buyers paying premium.`;
        break;
      }
      case 'surplus': {
        const candidates = Object.keys(st.produces).filter((g) => stock[g] !== undefined);
        if (candidates.length === 0) return null;
        goodId = this.rng.pick(candidates);
        stock[goodId] = Math.min(target[goodId] * STOCK_CAP_FACTOR, stock[goodId] + target[goodId] * 2);
        priceMult = 0.8;
        headline = `${st.name} floods local market with surplus ${GOODS[goodId].name}.`;
        break;
      }
      case 'blockade': {
        goodId = this.rng.pick(['food', 'medicine', 'fuel_cells', 'machinery']);
        priceMult = 1.4;
        headline = `Scrapper activity chokes shipping lanes near ${st.name} — ${GOODS[goodId].name} prices spike.`;
        break;
      }
      case 'boom': {
        goodId = this.rng.pick(['machinery', 'ship_parts', 'steel', 'components']);
        priceMult = 1.35;
        headline = `Industrial boom at ${st.name}: contractors hoarding ${GOODS[goodId].name}.`;
        break;
      }
    }
    if (stock[goodId] === undefined) return null;
    const ev: EconEvent = {
      kind, stationId: st.id, goodId, priceMult,
      endsAt: time + this.rng.range(180, 420), headline,
    };
    this.events.push(ev);
    return ev;
  }

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  // Unit price before spread. Deterministic noise keeps idle prices breathing.
  unitPrice(stationId: string, goodId: string, time: number): number {
    const def = GOODS[goodId];
    const stock = this.stocks.get(stationId)?.[goodId];
    const target = this.targets.get(stationId)?.[goodId];
    if (stock === undefined || target === undefined) return def.basePrice;
    const ratio = stock / target;
    let mult = Math.min(2.3, Math.max(0.5, 1.65 - 0.65 * ratio));
    for (const ev of this.events) {
      if (ev.stationId === stationId && ev.goodId === goodId) mult *= ev.priceMult;
    }
    const wobble = (noise2(time / 240, hashStr(stationId + goodId), this.system.seed) - 0.5) * 2 * def.volatility * 0.15;
    return Math.max(1, def.basePrice * mult * (1 + wobble));
  }

  buyPrice(stationId: string, goodId: string, time: number): number {
    return Math.ceil(this.unitPrice(stationId, goodId, time) * (1 + SPREAD));
  }
  sellPrice(stationId: string, goodId: string, time: number): number {
    return Math.floor(this.unitPrice(stationId, goodId, time) * (1 - SPREAD));
  }

  stockOf(stationId: string, goodId: string): number {
    return Math.floor(this.stocks.get(stationId)?.[goodId] ?? 0);
  }

  market(station: StationDef, time: number): MarketEntry[] {
    return this.tradedGoods(station).map((good) => ({
      good,
      stock: this.stockOf(station.id, good),
      buyPrice: this.buyPrice(station.id, good, time),
      sellPrice: this.sellPrice(station.id, good, time),
    }));
  }

  // Execute a player purchase with slippage: price recomputed in chunks while
  // stock drains. Returns total cost, or null if stock is insufficient.
  executeBuy(stationId: string, goodId: string, qty: number, time: number): number | null {
    const stock = this.stocks.get(stationId);
    if (!stock || (stock[goodId] ?? 0) < qty) return null;
    let cost = 0;
    let remaining = qty;
    while (remaining > 0) {
      const chunk = Math.min(5, remaining);
      cost += this.buyPrice(stationId, goodId, time) * chunk;
      stock[goodId] -= chunk;
      remaining -= chunk;
    }
    return Math.round(cost);
  }

  // Execute a player sale with slippage. Stations always buy; flooding one
  // tanks the local price. Returns total proceeds.
  executeSell(stationId: string, goodId: string, qty: number, time: number): number {
    const stock = this.stocks.get(stationId);
    if (!stock) return 0;
    if (stock[goodId] === undefined) stock[goodId] = 0;
    let proceeds = 0;
    let remaining = qty;
    while (remaining > 0) {
      const chunk = Math.min(5, remaining);
      proceeds += this.sellPrice(stationId, goodId, time) * chunk;
      stock[goodId] += chunk;
      remaining -= chunk;
    }
    return Math.round(proceeds);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  serialize(): EconomySave {
    const stocks: Record<string, StationStocks> = {};
    for (const [id, s] of this.stocks) stocks[id] = { ...s };
    return { stocks, events: this.events.map((e) => ({ ...e })), nextEventAt: this.nextEventAt, rngState: this.rng.getState() };
  }

  restore(save: EconomySave): void {
    for (const [id, s] of Object.entries(save.stocks)) {
      const cur = this.stocks.get(id);
      if (cur) Object.assign(cur, s);
    }
    this.events = save.events.map((e) => ({ ...e }));
    this.nextEventAt = save.nextEventAt;
    this.rng.setState(save.rngState);
  }
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000;
}
