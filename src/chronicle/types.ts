// The Chronicle: complete post-hoc record of one rotation (ADR-002).
// Pure data — no engine or node imports beyond engine types.
import type { Message, Resource, ResourceQty, WorldEvent } from '../engine/types';
import type { ScenarioShock } from '../engine/scenario';

export interface ChronicleSeat {
  spec: string;
  cityId: string;
  cityName: string;
  status: string;
  finalPop: number;
  collapsedTick?: number;
  agreements: number;
  reliability: { promised: number; delivered: number };
  defectionsCommitted: number;
  defectionsSuffered: number;
  cost?: number;
  retries?: number;
  failures?: number;
  adaptations?: number;
}

export interface ChronicleOffer {
  id: string;
  from: string;
  to: string;
  give: ResourceQty;
  receive: ResourceQty;
  duration: number;
  createdTick: number;
  expiresTick: number;
  status: string;
}

export interface ChronicleAgreement {
  id: string;
  a: string;
  b: string;
  aGives: ResourceQty;
  bGives: ResourceQty;
  startTick: number;
  endTick: number;
  fulfillment: Record<string, { promised: number; delivered: number }>;
}

export interface ChronicleCity {
  id: string;
  name: string;
  color: string;
  site: { x: number; y: number };
  produces: [Resource, Resource];
  lore?: string;
}

// Viewer-only annotation: a defection recorded while the actor's seat was
// passing ticks due to API failure (timeout/5xx/budget), i.e. the engine
// detected a shortfall the model never chose. Derived from call logs at
// viewer-build time; never written back to chronicle-rotN.json on disk.
export type ChronicleEvent = WorldEvent & { mechanical?: boolean };

export interface Chronicle {
  version: 1;
  rotation: number;
  ticksRun: number;
  world: {
    scenarioName?: string;
    premise?: string;
    designNotes?: string;
    seed: number;
    gridSize: number;
  };
  cities: ChronicleCity[];
  shocks?: ScenarioShock[]; // the scheduled history (targets by city name)
  assignment: Record<string, string>; // cityId → seat spec
  firstDefection?: { tick: number; cityId: string; spec: string };
  seats: ChronicleSeat[];
  events: ChronicleEvent[];
  messages: Message[];
  journals: Record<string, Array<{ tick: number; text: string }>>; // deduped snapshots
  popSeries: Record<string, number[]>;
  stockpileSeries: Record<string, Record<Resource, number[]>>;
  offers: ChronicleOffer[];
  agreements: ChronicleAgreement[];
}
