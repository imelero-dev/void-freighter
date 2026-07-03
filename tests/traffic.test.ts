import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { v3, vdist, vlen } from '../src/sim/vec';

function runTicks(sim: Sim, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...sim.tick());
  return events;
}

function capitals(sim: Sim) {
  return [...sim.entities.values()].filter((e) => e.kind === 'ship' && e.capital);
}

describe('ambient traffic & capitals (#11)', () => {
  it('a player in open space reliably encounters a superfreighter convoy', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('trucker');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    // park in quiet open space, far from stations and belts
    e.pos = v3(5e6, 2e5, 5e6);
    e.vel = v3();
    const meta = sim.meta(pid)!;
    meta.interdictCooldown = 1e9;
    let sawCapital = false;
    let sawLog = false;
    for (let s = 0; s < 400 && !sawCapital; s++) {
      const events = runTicks(sim, 20); // one second at a time
      if (events.some((ev) => ev.type === 'log' && /Capital signature/.test((ev as any).text))) sawLog = true;
      if (capitals(sim).length > 0) sawCapital = true;
    }
    expect(sawCapital).toBe(true);
    expect(sawLog).toBe(true);
    const cap = capitals(sim)[0];
    expect(cap.radius).toBeGreaterThanOrEqual(90); // capital-sized, not a dinghy
    expect(vlen(cap.vel)).toBeGreaterThan(0);      // actually underway
    // spawned within encounter range of the player, not beyond despawn
    expect(vdist(cap.pos, e.pos)).toBeLessThan(45_000);
  });

  it('armed cargo capitals with live turrets spawn in red space', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('hunter');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    // sit in the Shatter (danger ~0.85)
    const shatter = sim.system.belts.find((b) => b.id === 'shatter')!;
    e.pos = { ...shatter.fields[0].pos };
    e.pos.y += 3000;
    e.vel = v3();
    const meta = sim.meta(pid)!;
    meta.interdictCooldown = 1e9;
    let armed = null;
    for (let s = 0; s < 900 && !armed; s++) {
      runTicks(sim, 20);
      armed = [...sim.entities.values()].find((t) => t.kind === 'ship' && t.pirate === 'corvette') ?? null;
      // keep the player alive and anchored for the test
      e.hull = e.maxHull;
      e.pos = { ...shatter.fields[0].pos };
      e.pos.y += 3000;
    }
    expect(armed).not.toBeNull();
    // its turrets ride along as destructible parts
    const turrets = [...sim.entities.values()].filter((t) => t.pirate === 'turret' && t.parentId === armed!.id);
    expect(turrets.length).toBeGreaterThanOrEqual(4);
  });

  it('killing a civilian superfreighter spills freight and burns reputation', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('pirate_player');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    e.pos = v3(5e6, 2e5, 5e6);
    const meta = sim.meta(pid)!;
    meta.interdictCooldown = 1e9;
    // force a convoy spawn
    let cap = null;
    for (let s = 0; s < 600 && !cap; s++) {
      runTicks(sim, 20);
      cap = capitals(sim).find((c) => !c.pirate) ?? null;
      e.pos = v3(5e6, 2e5, 5e6);
      e.hull = e.maxHull;
    }
    expect(cap).not.toBeNull();
    const faction = cap!.factionId;
    const lootBefore = [...sim.entities.values()].filter((t) => t.kind === 'loot').length;
    sim.applyDamage(cap!, 1e9, pid, false);
    const lootAfter = [...sim.entities.values()].filter((t) => t.kind === 'loot').length;
    expect(sim.entities.has(cap!.id)).toBe(false);
    expect(lootAfter - lootBefore).toBeGreaterThanOrEqual(4);
    expect(sim.repOf(meta.profile, faction)).toBeLessThan(0);
  });

  it('traffic despawns once it reaches its destination or loses its audience', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('watcher');
    sim.undock(pid);
    const e = sim.entities.get(pid)!;
    e.pos = v3(5e6, 2e5, 5e6);
    const meta = sim.meta(pid)!;
    meta.interdictCooldown = 1e9;
    let cap = null;
    for (let s = 0; s < 600 && !cap; s++) {
      runTicks(sim, 20);
      cap = capitals(sim).find((c) => !c.pirate) ?? null;
      e.pos = v3(5e6, 2e5, 5e6);
    }
    expect(cap).not.toBeNull();
    // teleport it to its destination doorstep: next tick it docks off-sim
    cap!.pos = { ...cap!.navDest! };
    runTicks(sim, 2);
    expect(sim.entities.has(cap!.id)).toBe(false);
  });
});
