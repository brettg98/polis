export type Resource = 'food' | 'energy' | 'materials';
export const RESOURCES: readonly Resource[] = ['food', 'energy', 'materials'];
export type ResourceSet = Record<Resource, number>;
export const zeroResources = (): ResourceSet => ({ food: 0, energy: 0, materials: 0 });

export type CityStatus = 'alive' | 'struggling' | 'ruins';
export type Personality = 'honest' | 'opportunist';

export interface City {
  id: string;
  name: string;
  color: string;
  site: { x: number; y: number };
  produces: [Resource, Resource];
  personality: Personality;
  population: number;
  startPopulation: number;
  stockpiles: ResourceSet;
  unrest: number;
  status: CityStatus;
  collapsedTick?: number;
}

export interface ResourceQty {
  resource: Resource;
  qty: number;
}

export interface Offer {
  id: string;
  from: string;
  to: string;
  give: ResourceQty; // what `from` ships, per tick
  receive: ResourceQty; // what `from` gets back, per tick
  duration: number; // ticks of deliveries once active
  createdTick: number;
  expiresTick: number;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
}

// An agreement is a promise, not a transfer. Deliveries are separate actions
// each party must take every active tick; the engine only keeps the books.
export interface Agreement {
  id: string;
  a: string; // offer.from
  b: string; // offer.to
  aGives: ResourceQty;
  bGives: ResourceQty;
  startTick: number; // first tick deliveries land
  endTick: number; // exclusive
  fulfillment: Record<string, { promised: number; delivered: number }>;
}

export interface Message {
  from: string;
  to: string;
  tick: number;
  text: string;
}

export type EventKind = 'pact' | 'collapse' | 'shortage' | 'defection' | 'embargo' | 'shock' | 'info';

export interface WorldEvent {
  tick: number;
  kind: EventKind;
  text: string;
  isPublic: boolean; // public events appear in seat observations; private ones only in the observer log
  actor?: string; // city id that did the thing (shorted, collapsed, embargoed, offered)
  target?: string; // city id on the receiving end, where applicable
}

// ---- seat-facing views (fog of war applied server-side) ----

export interface CityPublicView {
  cityId: string;
  name: string;
  position: { x: number; y: number };
  produces: [Resource, Resource]; // terrain is visible, so production capability is public
  apparentSize: 'small' | 'medium' | 'large';
  status: CityStatus;
  transportEfficiency: number; // fraction of an origin-measured shipment that arrives (symmetric)
}

// Public knowledge of a shock: announced (upcoming) or active (in effect).
export interface ShockView {
  name: string;
  description: string;
  target: string; // cityId or 'all'
  resource: Resource | 'all';
  startTick: number;
  duration: number;
  multiplier: number;
  status: 'announced' | 'active';
}

// Private, always-accurate advance knowledge — only the target city sees this,
// and only until the shock becomes public.
export interface ForewarningView {
  name: string;
  description: string;
  resource: Resource | 'all';
  startTick: number;
  duration: number;
  multiplier: number;
}

export interface OfferView {
  id: string;
  from: string;
  to: string;
  give: ResourceQty;
  receive: ResourceQty;
  duration: number;
  expiresTick: number;
}

export interface AgreementView {
  id: string;
  counterparty: string;
  youGive: ResourceQty;
  youReceive: ResourceQty;
  ticksRemaining: number;
  deliveryDueNow: boolean; // deliveries submitted this tick will count toward this agreement
  yourFulfillment: { promised: number; delivered: number };
  theirFulfillment: { promised: number; delivered: number };
}

export interface SeatObservation {
  tick: number;
  you: {
    cityId: string;
    name: string;
    produces: [Resource, Resource];
    stockpiles: ResourceSet;
    stockpileCap: number;
    production: ResourceSet;
    consumption: ResourceSet;
    population: number;
    unrest: number;
    status: CityStatus;
    ticksUntilShortage: Partial<Record<Resource, number>>;
    forewarnings: ForewarningView[];
  };
  world: { cities: CityPublicView[]; shocks: ShockView[]; publicEvents: WorldEvent[] };
  ledger: {
    incomingOffers: OfferView[];
    outgoingOffers: OfferView[];
    agreements: AgreementView[];
  };
  inbox: Message[];
  memory: string; // the seat's own journal from last tick, verbatim
}

export interface SeatAction {
  messages?: { to: string; text: string }[];
  offers?: { to: string; give: ResourceQty; receive: ResourceQty; duration: number }[];
  responses?: { offerId: string; decision: 'accept' | 'reject' }[];
  deliveries?: { agreementId: string; qty: number }[];
  policies?: { embargo?: string[] };
  memory?: string;
}

export interface Seat {
  readonly cityId: string;
  readonly label: string;
  getAction(obs: SeatObservation): Promise<SeatAction>;
}
