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
  // Materials-funded growth (ADR-004). `ceilingBonus` adds to the population
  // ceiling only — it never moves the warehouse limit or the death threshold,
  // both of which stay anchored to startPopulation.
  buildProgress: number; // materials banked toward the next ceiling step
  ceilingBonus: number; // ceiling added by completed steps
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

export type EventKind = 'pact' | 'collapse' | 'shortage' | 'defection' | 'embargo' | 'shock' | 'build' | 'info';

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
  apparentSize: 'small' | 'medium' | 'large' | 'huge';
  // Built and physical, so public (ADR-004): a neighbour can see that a city
  // has made room to grow. Materials banked toward the next step are private.
  ceiling: number;
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
    // The most population this city can reach. Tournament-1 seats were never
    // told this — a city at 150 watched growth stop and had to infer why.
    ceiling: number;
    buildProgress: number; // materials banked toward the next ceiling step
    nextStepCost: number; // materials still needed to complete that step
    // Every resource must stay above this after consumption or population does
    // not grow that tick. Added 2026-08-04 (#34): the ceiling and the step cost
    // were visible from the start while this, the constraint that actually caps
    // population, was not — so seats optimised the price they could see. It
    // scales with population, so it is a live number rather than a constant.
    growthFloor: number;
    // Ticks left in the run, present only when the run discloses its horizon
    // (#35). Absent by default, which is the condition every tournament to date
    // was played under.
    ticksRemaining?: number;
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
  // Materials to put toward the ceiling this turn (ADR-004). Optional on the
  // type so scripted seats simply omit it — they never build, which keeps the
  // genmap sanity gate certifying exactly what it certified before.
  build?: number;
  policies?: { embargo?: string[] };
  memory?: string;
}

export interface Seat {
  readonly cityId: string;
  readonly label: string;
  getAction(obs: SeatObservation): Promise<SeatAction>;
}
