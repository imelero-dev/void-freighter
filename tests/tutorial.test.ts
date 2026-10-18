import { describe, expect, it } from 'vitest';
import {
  freshTutorialState, pickRookieContract, TutorialController, TUTORIAL_STEPS,
  type TutorialStep, type TutorialView,
} from '../src/game/tutorial';
import { ContractBoards } from '../src/sim/contracts';
import { Sim } from '../src/sim/sim';
import type { Contract, SimEvent } from '../src/sim/types';
import { v3, vdist } from '../src/sim/vec';

const PID = 7;

function haul(id: string, dest = 'dest_st'): Contract {
  return {
    id, type: 'transport', from: 'home', dest, good: 'food', qty: 8,
    killsRequired: 0, killsDone: 0, pirateZone: null, deadline: 9999, reward: 300,
    repReward: 2, factionId: 'helion', accepted: false, desc: `Haul 8× Food (${id}).`,
  };
}

function view(over: Partial<TutorialView> = {}): TutorialView {
  return {
    dockedAt: 'home', contracts: [], board: [haul('offer1')], destinationId: null, cruise: 'off',
    stationName: (id) => id.toUpperCase(), ...over,
  };
}

function controller() {
  const changes: TutorialStep[] = [];
  const t = new TutorialController(freshTutorialState(), (s) => changes.push(s.step));
  return { t, changes };
}

describe('tutorial step state machine', () => {
  it('walks the six steps in order, each one only on its trigger', () => {
    const { t, changes } = controller();
    const accepted = haul('offer1');

    // 1. market: auto-opened on dock; nothing advances until it is closed
    t.sync(view());
    t.handleSignal({ type: 'windowOpened', id: 'market' });
    t.handleEvent({ type: 'undocked', pid: PID, stationId: 'home' }, PID);
    expect(t.step).toBe('market');
    expect(t.hint(view())!.index).toBe(1);
    t.handleSignal({ type: 'windowClosed', id: 'market' });
    expect(t.step).toBe('contract');

    // 2. contract: the board singles out the rookie haul; accept advances
    expect(t.focusContract(view())!.id).toBe('offer1');
    expect(t.hint(view())!.text).toContain('★ TUTORIAL');
    t.sync(view());
    expect(t.step).toBe('contract');
    const docked = view({ contracts: [accepted], board: [] });
    t.sync(docked);
    expect(t.step).toBe('undock');
    expect(t.state.contractId).toBe('offer1');

    // 3. undock: an unrelated pilot's undock does not count
    t.handleEvent({ type: 'cruiseChange', entityId: PID, state: 'cruise' }, PID);
    t.handleEvent({ type: 'undocked', pid: PID + 1, stationId: 'home' }, PID);
    t.sync(docked);
    expect(t.step).toBe('undock');
    t.handleEvent({ type: 'undocked', pid: PID, stationId: 'home' }, PID);
    expect(t.step).toBe('destination');

    // 4. destination: must be the contract's drop-off
    const flying = view({ dockedAt: null, contracts: [accepted], board: [] });
    t.sync({ ...flying, destinationId: 'somewhere_else' });
    expect(t.step).toBe('destination');
    expect(t.hint(flying)!.text).toContain('DEST_ST');
    t.sync({ ...flying, destinationId: 'dest_st' });
    expect(t.step).toBe('cruise');

    // 5. cruise: charging is not enough, the engaged event is
    const routed = { ...flying, destinationId: 'dest_st' };
    t.handleEvent({ type: 'cruiseChange', entityId: PID, state: 'charging' }, PID);
    t.sync({ ...routed, cruise: 'charging' });
    expect(t.step).toBe('cruise');
    t.handleEvent({ type: 'cruiseChange', entityId: PID, state: 'cruise' }, PID);
    expect(t.step).toBe('deliver');

    // 6. deliver: only the tracked contract's payout finishes it
    t.handleEvent({ type: 'contractDone', pid: PID, contractId: 'other', reward: 50 }, PID);
    expect(t.step).toBe('deliver');
    t.handleEvent({ type: 'contractDone', pid: PID, contractId: 'offer1', reward: 300 }, PID);
    expect(t.step).toBe('done');
    expect(t.active).toBe(false);
    expect(t.delivered).toBe(true);
    expect(t.hint(view())).toBeNull();
    expect(changes).toEqual(['contract', 'undock', 'destination', 'cruise', 'deliver', 'done']);
    expect(TUTORIAL_STEPS.length).toBe(6);
  });

  it('skip ends it for good and ignores later events', () => {
    const { t, changes } = controller();
    t.skip();
    expect(t.step).toBe('done');
    expect(t.delivered).toBe(false);
    t.handleSignal({ type: 'windowClosed', id: 'market' });
    t.sync(view({ contracts: [haul('x')] }));
    expect(t.step).toBe('done');
    expect(changes).toEqual(['done']);
  });

  it('opening the board early also completes the market step', () => {
    const { t } = controller();
    t.handleSignal({ type: 'windowOpened', id: 'contracts' });
    expect(t.step).toBe('contract');
  });

  it('a failed haul sends the pilot back to the board', () => {
    const { t } = controller();
    t.handleSignal({ type: 'windowClosed', id: 'market' });
    t.sync(view({ contracts: [haul('c1')] }));
    t.handleEvent({ type: 'undocked', pid: PID, stationId: 'home' }, PID);
    t.handleEvent({ type: 'contractFailed', pid: PID, contractId: 'c1', desc: 'late' }, PID);
    expect(t.step).toBe('contract');
    expect(t.state.contractId).toBeNull();
    expect(t.hint(view({ dockedAt: null }))!.text).toMatch(/^Dock at any station/);
  });

  it('respawning at another station rewinds to undock; abandoning rewinds to the board', () => {
    const { t } = controller();
    const c = haul('c1');
    t.handleSignal({ type: 'windowClosed', id: 'market' });
    t.sync(view({ contracts: [c] }));
    t.handleEvent({ type: 'undocked', pid: PID, stationId: 'home' }, PID);
    t.sync(view({ dockedAt: null, contracts: [c], destinationId: 'dest_st' }));
    expect(t.step).toBe('cruise');
    t.sync(view({ dockedAt: 'home', contracts: [c] }));
    expect(t.step).toBe('undock');
    t.sync(view({ dockedAt: 'home', contracts: [] }));
    expect(t.step).toBe('contract');
  });

  it('a pilot who got ahead of the script skips the satisfied steps', () => {
    const { t } = controller();
    // resumed in flight, haul aboard, destination set, already cruising
    t.sync(view({ dockedAt: null, contracts: [haul('c1')], destinationId: 'dest_st', cruise: 'cruise' }));
    expect(t.step).toBe('deliver');
  });
});

describe('rookie contract pick', () => {
  it('prefers the shortest legal, ungated transport run', () => {
    const far = haul('far', 'far_st');
    const near = haul('near', 'near_st');
    const smuggle = { ...haul('stims', 'nearest_st'), good: 'stims' };
    const bounty = { ...haul('bounty', 'home'), type: 'bounty' as const, good: null };
    const gated = { ...haul('gated', 'nearest_st'), reward: 5000 };
    const dist: Record<string, number> = { far_st: 9e7, near_st: 2e6, nearest_st: 1e6, home: 0 };
    const board = [bounty, far, smuggle, gated, near];
    expect(pickRookieContract(board, (id) => dist[id])!.id).toBe('near');
    expect(pickRookieContract(board)!.id).toBe('far'); // no distances: board order
    expect(pickRookieContract([bounty, gated])).toBeNull();
    // 8× Food = 8 m³: does not fit a 5 m³ hold
    expect(pickRookieContract(board, (id) => dist[id], 5)).toBeNull();
  });
});

describe('tutorial against the real sim', () => {
  it('the guaranteed rookie haul is acceptable and deliverable by a fresh pilot', () => {
    const sim = new Sim();
    const pid = sim.addPlayer('rookie');
    const meta = sim.meta(pid)!;
    const e = sim.entities.get(pid)!;
    const t = new TutorialController(freshTutorialState());
    const viewOf = (): TutorialView => ({
      dockedAt: e.dockedAt,
      contracts: meta.profile.contracts,
      board: e.dockedAt ? sim.boardFor(e.dockedAt) : [],
      destinationId: meta.destination?.id ?? null,
      cruise: e.cruise,
      stationName: (id) => sim.station(id)?.name ?? id,
      routeLength: (id) => (e.dockedAt ? vdist(sim.station(e.dockedAt)!.pos, sim.station(id)!.pos) : Infinity),
      cargoFree: sim.cargoFree(pid),
    });
    const feed = (events: SimEvent[]) => {
      for (const ev of events) t.handleEvent(ev, pid);
      t.sync(viewOf());
    };
    const run = (ticks: number) => {
      for (let i = 0; i < ticks; i++) feed(sim.tick());
    };

    run(1);
    t.handleSignal({ type: 'windowClosed', id: 'market' });
    const offer = t.focusContract(viewOf())!;
    expect(offer).toBeTruthy();
    const home = sim.station(e.dockedAt!)!;
    expect(offer).toBe(pickRookieContract(sim.boardFor(home.id), (id) => vdist(home.pos, sim.station(id)!.pos), sim.cargoFree(pid)));
    expect(offer.type).toBe('transport');
    expect(ContractBoards.repRequired(offer)).toBeLessThan(0);

    sim.acceptContract(pid, offer.id);
    run(1);
    expect(t.step).toBe('undock');

    sim.undock(pid);
    run(1);
    expect(t.step).toBe('destination');

    const dest = sim.station(offer.dest)!;
    sim.setDestination(pid, { kind: 'station', id: dest.id, name: dest.name, pos: { ...dest.pos } });
    run(1);
    expect(t.step).toBe('cruise');

    // fly clear of the station mass-lock, then engage cruise
    e.pos = { x: e.pos.x + 4e6, y: e.pos.y + 4e6, z: e.pos.z };
    sim.toggleCruise(pid);
    run(20 * 10);
    expect(t.step).toBe('deliver');

    // arrive and dock
    sim.toggleCruise(pid);
    run(1);
    e.pos = { x: dest.pos.x + 1200, y: dest.pos.y, z: dest.pos.z };
    e.vel = v3();
    sim.requestDock(pid);
    run(20 * 6);
    expect(e.dockedAt).toBe(dest.id);
    expect(t.step).toBe('done');
    expect(t.delivered).toBe(true);
  });
});
