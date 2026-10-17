// Guided first haul: a skippable 6-step scripted first contract for new
// offline pilots. Pure state machine (no DOM, no storage) so it can be unit
// tested; the GameApp feeds it SimEvents + UI signals and draws the hint.
//
// Steps advance on the real thing happening: a SimEvent where the sim emits
// one (undocked, cruiseChange, contractDone), otherwise the observed state
// (a contract appearing in the profile, the destination being set) — the
// sim has no event for those. No sim changes.

import { ContractBoards } from '../sim/contracts';
import { GOODS } from '../sim/data';
import type { Contract, CruiseState, SimEvent } from '../sim/types';

export const TUTORIAL_STEPS = ['market', 'contract', 'undock', 'destination', 'cruise', 'deliver'] as const;
export type TutorialStep = (typeof TUTORIAL_STEPS)[number] | 'done';

export interface TutorialState {
  step: TutorialStep;
  contractId: string | null; // the haul the tutorial is tracking
}

export function freshTutorialState(): TutorialState {
  return { step: 'market', contractId: null };
}

export function doneTutorialState(): TutorialState {
  return { step: 'done', contractId: null };
}

// Per-frame snapshot of the bits of world state the tutorial cares about.
export interface TutorialView {
  dockedAt: string | null;
  contracts: Contract[];        // active contracts in the profile
  board: Contract[];            // offers at the docked station ([] in flight)
  destinationId: string | null;
  cruise: CruiseState;
  stationName(id: string): string;
  // distance from the docked station to another one (picks the shortest run)
  routeLength?(stationId: string): number;
  cargoFree?: number; // free hold volume, m³
}

// UI-only signals (windows have no SimEvent)
export type TutorialSignal = { type: 'windowOpened' | 'windowClosed'; id: string };

// Key labels for hint text (keys are rebindable)
export interface TutorialKeys {
  market: string; dock: string; map: string; dest: string;
  throttleUp: string; cruise: string;
}

export const DEFAULT_KEYS: TutorialKeys = {
  market: 'K', dock: 'SPACE', map: 'M', dest: 'N', throttleUp: 'W', cruise: 'CAPS',
};

export interface TutorialHint {
  index: number; // 1-based step number (0 = completion message)
  total: number;
  text: string;
}

function isHaul(c: Contract): boolean {
  return c.type === 'transport' || c.type === 'urgent';
}

// The guaranteed rookie run: every board's first offers are ungated local
// transport hauls sized for a starter hold (src/sim/contracts.ts). Among
// those, take legal cargo (no customs fines) that fits the hold, on the
// shortest route.
export function pickRookieContract(
  board: Contract[], routeLength?: (stationId: string) => number, cargoFree = Infinity,
): Contract | null {
  const ok = board.filter((c) => {
    const good = c.good ? GOODS[c.good] : undefined;
    return c.type === 'transport' && ContractBoards.repRequired(c) < 0 &&
      !!good && good.legal && good.volume * c.qty <= cargoFree;
  });
  if (ok.length === 0) return null;
  if (!routeLength) return ok[0];
  return ok.reduce((best, c) => (routeLength(c.dest) < routeLength(best.dest) ? c : best));
}

export class TutorialController {
  state: TutorialState;
  private reward = 0;

  constructor(
    state: TutorialState,
    // fired on every step change (persist + feedback)
    private onChange: (state: TutorialState, prev: TutorialStep) => void = () => {},
  ) {
    this.state = { ...state };
  }

  get active(): boolean {
    return this.state.step !== 'done';
  }

  // finished by delivering the haul (vs. skipped)
  get delivered(): boolean {
    return this.reward > 0;
  }

  get step(): TutorialStep {
    return this.state.step;
  }

  // the offer the board should single out (only while picking a contract)
  focusContract(view: TutorialView): Contract | null {
    if (this.state.step !== 'contract' || !view.dockedAt) return null;
    return pickRookieContract(view.board, view.routeLength, view.cargoFree);
  }

  skip(): void {
    this.go('done');
  }

  handleSignal(sig: TutorialSignal): void {
    if (this.state.step !== 'market') return;
    // looked at the market and moved on (closed it, or went to the board)
    if ((sig.type === 'windowClosed' && sig.id === 'market') ||
        (sig.type === 'windowOpened' && sig.id === 'contracts')) {
      this.go('contract');
    }
  }

  handleEvent(ev: SimEvent, playerId: number): void {
    if (!this.active) return;
    const s = this.state;
    switch (ev.type) {
      case 'undocked':
        if (ev.pid === playerId && s.step === 'undock') this.go('destination');
        break;
      case 'cruiseChange':
        if (ev.entityId === playerId && ev.state === 'cruise' && s.step === 'cruise') this.go('deliver');
        break;
      case 'contractDone':
        if (ev.pid === playerId && s.contractId !== null && ev.contractId === s.contractId) {
          this.reward = ev.reward;
          this.go('done');
        }
        break;
      case 'contractFailed':
        if (ev.pid === playerId && ev.contractId === s.contractId) {
          s.contractId = null;
          this.go('contract');
        }
        break;
    }
  }

  // State-driven transitions: steps with no SimEvent, plus recovery when the
  // player gets ahead of (or knocked off) the script.
  sync(view: TutorialView): void {
    if (!this.active) return;
    const s = this.state;
    const tracked = s.contractId ? view.contracts.find((c) => c.id === s.contractId) ?? null : null;
    if (s.contractId && !tracked && s.step !== 'market') {
      // abandoned (or otherwise gone without a contractDone): pick a new one
      s.contractId = null;
      this.go('contract');
      return;
    }
    // advance through every step whose goal is already met (at most 6 hops)
    for (let guard = 0; guard < TUTORIAL_STEPS.length; guard++) {
      const next = this.nextFromState(view);
      if (next === null) return;
      if (next === 'undock' && s.step === 'contract') s.contractId = view.contracts.find(isHaul)!.id;
      this.go(next);
    }
  }

  private nextFromState(view: TutorialView): TutorialStep | null {
    const step = this.state.step;
    // docked somewhere other than the drop-off mid-flight (death respawn,
    // wrong station): back to the undock step
    if ((step === 'destination' || step === 'cruise' || step === 'deliver') &&
        view.dockedAt && view.dockedAt !== this.trackedDest(view)) {
      return 'undock';
    }
    switch (step) {
      case 'market':
        // already accepted a haul (went straight to the board)
        return view.contracts.some(isHaul) ? 'contract' : null;
      case 'contract':
        return view.contracts.some(isHaul) ? 'undock' : null;
      case 'undock':
        return view.dockedAt ? null : 'destination';
      case 'destination':
        return view.destinationId !== null && view.destinationId === this.trackedDest(view) ? 'cruise' : null;
      case 'cruise':
        return view.cruise === 'cruise' ? 'deliver' : null;
      default:
        return null;
    }
  }

  private trackedDest(view: TutorialView): string | null {
    return view.contracts.find((c) => c.id === this.state.contractId)?.dest ?? null;
  }

  hint(view: TutorialView, keys: TutorialKeys = DEFAULT_KEYS): TutorialHint | null {
    const total = TUTORIAL_STEPS.length;
    const step = this.state.step;
    if (step === 'done') return null;
    const index = TUTORIAL_STEPS.indexOf(step) + 1;
    const destId = this.trackedDest(view);
    const dest = destId ? view.stationName(destId) : 'the drop-off';
    let text: string;
    switch (step) {
      case 'market':
        text = `Welcome aboard. This is the MARKET [${keys.market}] — what this station buys and sells. Close it to continue.`;
        break;
      case 'contract': {
        if (!view.dockedAt) {
          text = `Dock at any station [${keys.dock}] and accept a haul from its CONTRACTS board.`;
          break;
        }
        const offer = this.focusContract(view);
        text = offer
          ? `Open CONTRACTS on the top bar and ACCEPT the ★ TUTORIAL haul: ${offer.desc}`
          : 'Open CONTRACTS on the top bar and ACCEPT a transport haul.';
        break;
      }
      case 'undock':
        text = view.dockedAt && view.dockedAt !== destId
          ? `Cargo sealed aboard. Press ${keys.dock} to undock.`
          : `Press ${keys.dock} to undock.`;
        break;
      case 'destination':
        text = `Open the system chart [${keys.map}], click ${dest}, then SET DESTINATION [${keys.dest}].`;
        break;
      case 'cruise':
        text = `Throttle up [${keys.throttleUp}] to clear the station, then engage cruise drive [${keys.cruise}].`;
        break;
      case 'deliver':
        text = `Hands off the stick: cruise flies to the marker. Near ${dest}, drop cruise [${keys.cruise}], slow down and dock [${keys.dock}].`;
        break;
    }
    return { index, total, text };
  }

  // one-off completion line (shown by the app when the step turns 'done')
  completionText(): string {
    return this.delivered
      ? `First haul delivered — +${this.reward.toLocaleString('en-US')} cr. The board is yours now, pilot.`
      : 'Tutorial closed. F1 opens the flight manual any time.';
  }

  private go(step: TutorialStep): void {
    const prev = this.state.step;
    if (prev === step) return;
    this.state.step = step;
    if (step === 'done') this.state.contractId = null;
    this.onChange({ ...this.state }, prev);
  }
}
