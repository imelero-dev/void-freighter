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
  readonly vtolMode: boolean;     // VTOL hover flight mode engaged
  readonly gearDown: boolean;     // landing gear deployed
  readonly drillOn: boolean;
  readonly turboCharge: number;  // 0..1 burst gauge
  readonly turboActive: boolean;
  readonly drillHeat: number;    // 0..1 mining beam heat
  readonly drillOverheated: boolean;
  readonly miningBeamOn: boolean; // beam actually firing (RMB + drill + not overheated)
  // 0..1 fraction between the previous and current sim tick, for render interpolation
  readonly renderAlpha: number;

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
  setMiningBeam(on: boolean): void;
  toggleCruise(): void;
  toggleFlightAssist(): void;
  toggleVtol(): void;
  toggleGear(): void;
  setTarget(id: number | null): void;
  tabTarget(): void;
  targetReticle(): void;
  requestDock(): void;
  autodock(): void;
  undock(): void;
  setDestination(dest: Destination | null): void;
  hailRescue(): void;
  useFuelCells(qty: number): void;
  useRepairKit(): void;

  // station services
  buyGood(goodId: string, qty: number): void;
  sellGood(goodId: string, qty: number): void;
  refine(inputGood: string, qty: number): void;
  refuel(): void;
  repairHull(): void;
  restockMissiles(): void;
  restockCannonAmmo(): void;
  openDerelict(entityId: number): void;
  buyStationInfo(stationId: string): void;
  // wandering merchants
  hailMerchant(entityId: number): void;
  merchantBuy(entityId: number, goodId: string, qty: number): void;
  merchantBuyModule(entityId: number): void;
  merchantSell(entityId: number, goodId: string, qty: number): void;
  // workshop & warehouse
  rentWorkshop(): void;
  craftModule(slot: ModuleSlot, tier: number): void;
  craftRepairKit(): void;
  buyWarehousePlot(): void;
  warehouseDeposit(goodId: string, qty: number): void;
  warehouseWithdraw(goodId: string, qty: number): void;
  workshopActive(stationId: string): boolean;
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
