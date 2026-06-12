// Trade bot: finds the best arbitrage route on the live economy, buys cheap,
// hauls (teleport — we test the economy, not the flying), sells dear.
// Exits non-zero unless the run turns a profit.

import { loadSim } from './lib/sim_loader.mjs';

const { Sim, GOODS } = await loadSim();

const sim = new Sim();
const pid = sim.addPlayer('TradeBot');
const meta = sim.meta(pid);
const e = sim.entities.get(pid);
const startCredits = meta.profile.credits;
console.log(`▶ smoke_trade — starting credits: ${startCredits}`);

// scan all station pairs for the best spread the starter hold can exploit
const stations = sim.system.stations;
let best = null;
for (const from of stations) {
  const fromMarket = sim.economy.market(from, sim.time);
  for (const to of stations) {
    if (to.id === from.id) continue;
    const toMarket = sim.economy.market(to, sim.time);
    for (const entry of fromMarket) {
      if (!GOODS[entry.good].legal) continue; // play it safe, this bot has no black market contacts
      const sellThere = toMarket.find((x) => x.good === entry.good);
      if (!sellThere) continue;
      const margin = sellThere.sellPrice - entry.buyPrice;
      if (margin <= 0) continue;
      const qty = Math.min(entry.stock, Math.floor(30 / GOODS[entry.good].volume),
        Math.floor(meta.profile.credits / entry.buyPrice));
      const profit = margin * qty;
      if (qty > 0 && (!best || profit > best.profit)) {
        best = { from, to, good: entry.good, qty, buy: entry.buyPrice, sell: sellThere.sellPrice, margin, profit };
      }
    }
  }
}

if (!best) {
  console.error('❌ no profitable route found — economy is broken');
  process.exit(1);
}
console.log(`route: ${best.qty}× ${GOODS[best.good].name} | ${best.from.name} @${best.buy} → ${best.to.name} @${best.sell} (margin ${best.margin}/u, est ${best.profit})`);

// execute: dock at origin, buy
e.dockedAt = best.from.id;
sim.buyGood(pid, best.good, best.qty);
const afterBuy = meta.profile.credits;
console.log(`bought ${best.qty} for ${startCredits - afterBuy} cr`);
if (sim.freeQty(meta.profile, best.good) !== best.qty) {
  console.error('❌ buy failed');
  process.exit(1);
}

// haul + sell
e.dockedAt = best.to.id;
sim.sellGood(pid, best.good, best.qty);
const final = meta.profile.credits;
console.log(`sold for ${final - afterBuy} cr — net ${final - startCredits >= 0 ? '+' : ''}${final - startCredits} cr`);

if (final <= startCredits) {
  console.error('❌ trade run lost money');
  process.exit(1);
}
console.log('✅ smoke_trade passed — buy low, sell high, stay alive');
