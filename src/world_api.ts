// The surface the renderer + HUD consume. The offline OfflineWorld (wrapping
// Sim) and the online ClientWorld (mirroring server snapshots) both implement
// it — rendering and UI never know whether they are offline or online.

import type { ShipStats } from './sim/data';
import type {
  Contract, Destination, Entity, HullId, MarketEntry, ModuleSlot, PlayerProfile,
  ShipInput, SimEvent, StationDef, SystemDef,
} from './sim/types';
import type { Vec3 } from './sim/vec';

export interface IWorld {
  readonly system: SystemDef;
  readonly entities: Map<number, Entity>;
  readonly playerId: number;
  readonly player: Entity | null;
  readonly profile: PlayerProfile;
  readonly shipStats: ShipStats;
  readonly destination: Destination | null;
  readonly dockedStation: StationDef | null;
  readonly time: number;
  readonly newsLog: string[];
  readonly connected: boolean;
  readonly online: boolean;
  readonly flightAssist: boolean;
  readonly drillOn: boolean;

  // written by the input layer every frame
  input: ShipInput;

  // advance the world (offline: run sim ticks; online: send input, interpolate)
  update(dt: number): void;
  drainEvents(): SimEvent[];

  market(stationId: string): MarketEntry[] | null;
  board(stationId: string): Contract[];
  dangerAt(pos: Vec3): number;

  // flight
  setFiring(on: boolean): void;
  fireMissile(): void;
  setDrill(on: boolean): void;
  toggleCruise(): void;
  toggleFlightAssist(): void;
  setTarget(id: number | null): void;
  tabTarget(): void;
  targetReticle(): void;
  requestDock(): void;
  undock(): void;
  setDestination(dest: Destination | null): void;
  hailRescue(): void;
  useFuelCells(qty: number): void;

  // station services
  buyGood(goodId: string, qty: number): void;
  sellGood(goodId: string, qty: number): void;
  refine(inputGood: string, qty: number): void;
  refuel(): void;
  repairHull(): void;
  restockMissiles(): void;
  acceptContract(contractId: string): void;
  abandonContract(contractId: string): void;
  deliverSupply(contractId: string): void;
  buyModule(slot: ModuleSlot, tier: number): void;
  sellModule(slot: ModuleSlot): void;
  installStashModule(index: number): void;
  sellStashModule(index: number): void;
  buyHull(hullId: HullId): void;

  chat(text: string): void;
}
