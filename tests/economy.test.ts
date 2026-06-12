import { describe, expect, it } from 'vitest';
import { Economy, ECON_TICK_S } from '../src/sim/economy';
import { generateSystem } from '../src/sim/system';
import { Sim } from '../src/sim/sim';

describe('market model', () => {
  it('producers sell cheaper than consumers pay (arbitrage exists)', () => {
    const sys = generateSystem();
    const eco = new Economy(sys);
    // Morrow produces food; Cinder Forge consumes it
    const buyAtProducer = eco.buyPrice('morrow_granary', 'food', 0);
    const sellAtConsumer = eco.sellPrice('cinder_forge', 'food', 0);
    expect(sellAtConsumer).toBeGreaterThan(buyAtProducer);
  });

  it('large buys push the price up (slippage) and deplete stock', () => {
    const sys = generateSystem();
    const eco = new Economy(sys);
    const before = eco.buyPrice('morrow_granary', 'food', 0);
    const stockBefore = eco.stockOf('morrow_granary', 'food');
    eco.executeBuy('morrow_granary', 'food', Math.floor(stockBefore * 0.7), 0);
    const after = eco.buyPrice('morrow_granary', 'food', 0);
    expect(after).toBeGreaterThan(before);
    expect(eco.stockOf('morrow_granary', 'food')).toBeLessThan(stockBefore);
  });

  it('large sells tank the local price', () => {
    const sys = generateSystem();
    const eco = new Economy(sys);
    const before = eco.sellPrice('cinder_forge', 'food', 0);
    eco.executeSell('cinder_forge', 'food', 400, 0);
    const after = eco.sellPrice('cinder_forge', 'food', 0);
    expect(after).toBeLessThan(before);
  });

  it('prices revert toward equilibrium after a shock', () => {
    const sys = generateSystem();
    const eco = new Economy(sys);
    const baseline = eco.unitPrice('cinder_forge', 'food', 0);
    eco.executeSell('cinder_forge', 'food', 600, 0); // flood the market
    const shocked = eco.unitPrice('cinder_forge', 'food', 0);
    expect(shocked).toBeLessThan(baseline);
    // simulate ~30 min of economy
    let t = 0;
    for (let i = 0; i < 360; i++) {
      t += ECON_TICK_S;
      eco.tick(t, ECON_TICK_S);
    }
    const recovered = eco.unitPrice('cinder_forge', 'food', t);
    expect(recovered).toBeGreaterThan(shocked);
  });

  it('illegal goods only trade at the black market', () => {
    const sys = generateSystem();
    const eco = new Economy(sys);
    const morrow = sys.stations.find((s) => s.id === 'morrow_granary')!;
    const rust = sys.stations.find((s) => s.blackMarket)!;
    expect(eco.tradedGoods(morrow)).not.toContain('stims');
    expect(eco.tradedGoods(rust)).toContain('stims');
  });

  it('buy/sell round trip at one station loses money (spread)', () => {
    const sys = generateSystem();
    const eco = new Economy(sys);
    const cost = eco.executeBuy('the_drift', 'steel', 10, 0);
    const proceeds = eco.executeSell('the_drift', 'steel', 10, 0);
    expect(cost).not.toBeNull();
    expect(proceeds).toBeLessThan(cost!);
  });

  it('economy events spawn and expire', () => {
    const sys = generateSystem();
    const eco = new Economy(sys);
    let t = 0;
    let sawEvent = false;
    for (let i = 0; i < 1200 && !sawEvent; i++) {
      t += ECON_TICK_S;
      if (eco.tick(t, ECON_TICK_S)) sawEvent = true;
    }
    expect(sawEvent).toBe(true);
  });
});

describe('player trading through the sim', () => {
  it('buying then selling elsewhere can be profitable', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('trader');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    const startCredits = meta.profile.credits;

    // buy cheap food at the producer
    e.dockedAt = 'morrow_granary';
    sim.buyGood(pid, 'food', 20);
    expect(sim.freeQty(meta.profile, 'food')).toBe(20);
    expect(meta.profile.credits).toBeLessThan(startCredits);

    // sell it at the consumer
    e.dockedAt = 'cinder_forge';
    sim.sellGood(pid, 'food', 20);
    expect(sim.freeQty(meta.profile, 'food')).toBe(0);
    expect(meta.profile.credits).toBeGreaterThan(startCredits);
  });

  it('rejects buys beyond cargo capacity or credits', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('trader');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    e.dockedAt = 'morrow_granary';
    sim.buyGood(pid, 'food', 10_000); // way over capacity
    expect(sim.freeQty(meta.profile, 'food')).toBe(0);
    meta.profile.credits = 1;
    sim.buyGood(pid, 'food', 5);
    expect(sim.freeQty(meta.profile, 'food')).toBe(0);
    expect(meta.profile.credits).toBe(1);
  });

  it('refining converts ore with station efficiency and fee', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('miner');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    e.dockedAt = 'cinder_forge'; // eff 0.9
    sim.addCargo(meta.profile, 'iron_ore', 40);
    const creditsBefore = meta.profile.credits;
    sim.refine(pid, 'iron_ore', 40);
    expect(sim.freeQty(meta.profile, 'iron_ore')).toBe(0);
    expect(sim.freeQty(meta.profile, 'steel')).toBe(Math.floor((40 / 2) * 0.9)); // 18
    expect(meta.profile.credits).toBeLessThan(creditsBefore); // fee paid
  });
});
