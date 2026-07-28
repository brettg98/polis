import { RNG } from './rng';
import type { SimConfig } from './config';
import { Terrain, generateTerrain } from './terrain';
import { placeCities } from './cities';
import { citiesFromScenario, engineShocks, type EngineShock, type Scenario } from './scenario';
import {
  Agreement,
  AgreementView,
  City,
  CityPublicView,
  Message,
  Offer,
  OfferView,
  RESOURCES,
  Resource,
  Seat,
  SeatAction,
  SeatObservation,
  WorldEvent,
  zeroResources,
} from './types';

interface PendingDelivery {
  cityId: string;
  agreementId: string;
  qty: number;
}

// Tick order:
//   1. RESOLVE   — deliveries land, production, consumption, starvation, collapse
//   2. OBSERVE   — per-seat views built server-side (fog of war)
//   3. ACT       — every living seat returns a SeatAction (simultaneous)
//   4. APPLY     — offers registered, acceptances matched into agreements,
//                  promised deliveries queued for next tick's resolve
export class Simulation {
  tick = 0;
  readonly config: SimConfig;
  readonly terrain: Terrain;
  readonly cities: City[];
  readonly offers = new Map<string, Offer>();
  readonly agreements = new Map<string, Agreement>();
  readonly events: WorldEvent[] = [];
  // Every delivered message, durably — the Chronicle's diplomatic transcript
  // (ADR-002). Seats never see this; their inboxes are unchanged.
  readonly messageLog: Message[] = [];

  private inboxNow = new Map<string, Message[]>();
  private inboxNext = new Map<string, Message[]>();
  private pendingDeliveries: PendingDelivery[] = [];
  private embargoes = new Map<string, Set<string>>();
  private memories = new Map<string, string>();
  private idCounter = 0;

  private shocks: EngineShock[] = [];
  private transportEff = new Map<string, number>();

  constructor(cfg: SimConfig, scenario?: Scenario) {
    this.config = cfg;
    const rng = new RNG(cfg.seed);
    this.terrain = generateTerrain(rng, cfg.gridSize);
    this.cities = scenario ? citiesFromScenario(scenario, cfg, this.terrain) : placeCities(rng, this.terrain, cfg);
    if (scenario) this.shocks = engineShocks(scenario, this.cities);
    for (const a of this.cities) {
      for (const b of this.cities) {
        if (a.id >= b.id) continue;
        const d = Math.hypot(a.site.x - b.site.x, a.site.y - b.site.y);
        const eff = Math.max(cfg.trade.transportEfficiencyFloor, 1 - cfg.trade.transportLossPerCell * d);
        this.transportEff.set(`${a.id}|${b.id}`, Math.round(eff * 1000) / 1000);
      }
    }
  }

  transportEfficiency(a: string, b: string): number {
    if (a === b) return 1;
    return this.transportEff.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 1;
  }

  productionMultiplier(cityId: string, r: Resource): number {
    let m = 1;
    for (const s of this.shocks) {
      if (this.tick < s.startTick || this.tick >= s.endTick) continue;
      if (s.targetId !== 'all' && s.targetId !== cityId) continue;
      if (s.resource !== 'all' && s.resource !== r) continue;
      m *= s.multiplier;
    }
    return m;
  }

  city(id: string): City {
    return this.cities.find((c) => c.id === id)!;
  }

  aliveCities(): City[] {
    return this.cities.filter((c) => c.status !== 'ruins');
  }

  stockpileCap(c: City): number {
    return this.config.city.stockpileCapTicks * this.config.city.consumptionPerCapita * c.startPopulation;
  }

  activeAgreements(): Agreement[] {
    const out: Agreement[] = [];
    for (const ag of this.agreements.values()) {
      if (ag.startTick <= this.tick && this.tick < ag.endTick) {
        if (this.city(ag.a).status !== 'ruins' && this.city(ag.b).status !== 'ruins') out.push(ag);
      }
    }
    return out;
  }

  // Observer-only access to a seat's journal (seats themselves get it via
  // their observation). Used by run summaries and telemetry.
  memoryOf(cityId: string): string {
    return this.memories.get(cityId) ?? '';
  }

  reliabilityOf(cityId: string): { promised: number; delivered: number } {
    let promised = 0;
    let delivered = 0;
    for (const ag of this.agreements.values()) {
      const f = ag.fulfillment[cityId];
      if (f) {
        promised += f.promised;
        delivered += f.delivered;
      }
    }
    return { promised, delivered };
  }

  async step(seats: Map<string, Seat>): Promise<void> {
    this.tick++;
    this.resolve();
    this.inboxNow = this.inboxNext;
    this.inboxNext = new Map();
    const alive = this.aliveCities();
    if (alive.length === 0) return;
    const observations = alive.map((c) => this.buildObservation(c));
    const actions = await Promise.all(
      observations.map((o) => {
        const seat = seats.get(o.you.cityId);
        return seat ? seat.getAction(o).catch(() => ({}) as SeatAction) : Promise.resolve({} as SeatAction);
      }),
    );
    alive.forEach((c, i) => this.applyAction(c, actions[i] ?? {}));
    for (const offer of this.offers.values()) {
      if (offer.status === 'open' && this.tick >= offer.expiresTick) offer.status = 'expired';
    }
  }

  private emit(kind: WorldEvent['kind'], text: string, isPublic: boolean, actor?: string, target?: string): void {
    this.events.push({ tick: this.tick, kind, text, isPublic, actor, target });
  }

  private resolve(): void {
    const cc = this.config.city;

    // 0. shock announcements (visible in this tick's observations)
    for (const s of this.shocks) {
      const targetName = s.targetId === 'all' ? 'all cities' : this.city(s.targetId).name;
      const effect = `${s.resource} production ×${s.multiplier} for ${targetName}, t${s.startTick}–t${s.endTick - 1}`;
      const actor = s.targetId === 'all' ? undefined : s.targetId;
      if (this.tick === s.announceTick && s.visibility === 'forecast') {
        this.emit('shock', `Forecast — ${s.name}: ${effect}`, true, actor);
      }
      if (this.tick === s.startTick) this.emit('shock', `${s.name} has begun: ${effect}`, true, actor);
      if (this.tick === s.endTick) this.emit('shock', `${s.name} has ended`, true, actor);
    }

    // 1. deliveries promised during the previous tick land now
    const submitted = new Map<string, number>();
    for (const d of this.pendingDeliveries) {
      const key = `${d.cityId}|${d.agreementId}`;
      submitted.set(key, (submitted.get(key) ?? 0) + d.qty);
    }
    this.pendingDeliveries = [];
    for (const ag of this.agreements.values()) {
      if (!(ag.startTick <= this.tick && this.tick < ag.endTick)) continue;
      const cityA = this.city(ag.a);
      const cityB = this.city(ag.b);
      if (cityA.status === 'ruins' || cityB.status === 'ruins') continue;
      const sides = [
        { giver: cityA, receiver: cityB, gives: ag.aGives },
        { giver: cityB, receiver: cityA, gives: ag.bGives },
      ];
      for (const s of sides) {
        const due = s.gives.qty;
        const sub = submitted.get(`${s.giver.id}|${ag.id}`) ?? 0;
        const transfer = Math.min(Math.max(0, sub), due, s.giver.stockpiles[s.gives.resource]);
        s.giver.stockpiles[s.gives.resource] -= transfer;
        // origin-measured: transit loss is physics, never defection (ADR-003)
        s.receiver.stockpiles[s.gives.resource] += transfer * this.transportEfficiency(s.giver.id, s.receiver.id);
        const f = ag.fulfillment[s.giver.id];
        f.promised += due;
        f.delivered += transfer;
        // willful shorting: shipped essentially nothing while sitting on a
        // comfortable multiple of the due amount (partial payment from a
        // squeezed but honest city is not defection)
        if (sub < due * 0.05 && s.giver.stockpiles[s.gives.resource] >= due * 3) {
          this.emit(
            'defection',
            `${s.giver.name} shorted ${s.receiver.name} on ${s.gives.resource} (${transfer.toFixed(1)}/${due.toFixed(1)})`,
            false,
            s.giver.id,
            s.receiver.id,
          );
        }
      }
    }

    // 2. production, consumption, starvation, collapse
    for (const c of this.aliveCities()) {
      const cap = this.stockpileCap(c);
      for (const r of c.produces) c.stockpiles[r] += c.population * cc.productionPerCapita * this.productionMultiplier(c.id, r);
      for (const r of RESOURCES) c.stockpiles[r] = Math.min(c.stockpiles[r], cap);

      let worstMissing = 0;
      let worstRes: Resource = 'food';
      for (const r of RESOURCES) {
        const need = c.population * cc.consumptionPerCapita;
        const take = Math.min(c.stockpiles[r], need);
        c.stockpiles[r] -= take;
        const missing = need > 0 ? (need - take) / need : 0;
        if (missing > worstMissing) {
          worstMissing = missing;
          worstRes = r;
        }
      }

      const wasStatus = c.status;
      if (worstMissing > 0.001) {
        c.unrest = Math.min(1, c.unrest + cc.unrestRise * worstMissing);
        c.population *= 1 - cc.starvationDecline * worstMissing;
      } else {
        c.unrest = Math.max(0, c.unrest - cc.unrestFall);
        if (RESOURCES.every((r) => c.stockpiles[r] > cap * 0.25)) {
          c.population = Math.min(c.population * (1 + cc.growthRate), c.startPopulation * cc.maxGrowthFactor);
        }
      }

      if (c.population < cc.collapseFraction * c.startPopulation) {
        c.status = 'ruins';
        c.collapsedTick = this.tick;
        this.emit('collapse', `${c.name} has collapsed`, true, c.id);
      } else {
        c.status = worstMissing > 0.001 ? 'struggling' : 'alive';
        if (c.status === 'struggling' && wasStatus !== 'struggling') {
          this.emit('shortage', `${c.name} is starving for ${worstRes}`, true, c.id);
        }
      }
    }
  }

  private buildObservation(c: City): SeatObservation {
    const cc = this.config.city;
    const cap = this.stockpileCap(c);
    const production = zeroResources();
    for (const r of c.produces) production[r] = c.population * cc.productionPerCapita * this.productionMultiplier(c.id, r);
    const consumption = zeroResources();
    for (const r of RESOURCES) consumption[r] = c.population * cc.consumptionPerCapita;

    // committed flows from currently-active agreements, for shortage projection
    const inflow = zeroResources();
    const outflow = zeroResources();
    for (const ag of this.activeAgreements()) {
      if (ag.a === c.id) {
        outflow[ag.aGives.resource] += ag.aGives.qty;
        inflow[ag.bGives.resource] += ag.bGives.qty;
      } else if (ag.b === c.id) {
        outflow[ag.bGives.resource] += ag.bGives.qty;
        inflow[ag.aGives.resource] += ag.aGives.qty;
      }
    }
    const ticksUntilShortage: Partial<Record<Resource, number>> = {};
    for (const r of RESOURCES) {
      const net = consumption[r] + outflow[r] - production[r] - inflow[r];
      if (net > 0.0001) ticksUntilShortage[r] = Math.max(0, Math.floor(c.stockpiles[r] / net));
    }

    const others: CityPublicView[] = this.cities
      .filter((o) => o.id !== c.id)
      .map((o) => ({
        cityId: o.id,
        name: o.name,
        position: { ...o.site },
        produces: [...o.produces] as [Resource, Resource],
        apparentSize: o.population < 70 ? 'small' : o.population < 115 ? 'medium' : 'large',
        status: o.status,
        transportEfficiency: this.transportEfficiency(c.id, o.id),
      }));

    // public shock knowledge: announced (upcoming) or active
    const shockViews = this.shocks
      .filter((s) => this.tick >= s.announceTick && this.tick < s.endTick)
      .map((s) => ({
        name: s.name,
        description: s.description,
        target: s.targetId,
        resource: s.resource,
        startTick: s.startTick,
        duration: s.duration,
        multiplier: s.multiplier,
        status: (this.tick >= s.startTick ? 'active' : 'announced') as 'active' | 'announced',
      }));

    // private forewarnings: target city only, only until the public knows
    const forewarnings = this.shocks
      .filter(
        (s) =>
          s.privateWarning !== undefined &&
          s.targetId === c.id &&
          this.tick >= s.startTick - s.privateWarning &&
          this.tick < s.announceTick,
      )
      .map((s) => ({
        name: s.name,
        description: s.description,
        resource: s.resource,
        startTick: s.startTick,
        duration: s.duration,
        multiplier: s.multiplier,
      }));

    const myEmbargo = this.embargoes.get(c.id);
    const toView = (o: Offer): OfferView => ({
      id: o.id,
      from: o.from,
      to: o.to,
      give: { ...o.give },
      receive: { ...o.receive },
      duration: o.duration,
      expiresTick: o.expiresTick,
    });
    const allOffers = [...this.offers.values()];
    const incomingOffers = allOffers
      .filter(
        (o) =>
          o.status === 'open' &&
          o.to === c.id &&
          this.tick < o.expiresTick &&
          !myEmbargo?.has(o.from) &&
          this.city(o.from).status !== 'ruins',
      )
      .map(toView);
    const outgoingOffers = allOffers
      .filter((o) => o.status === 'open' && o.from === c.id && this.tick < o.expiresTick)
      .map(toView);

    const agreements: AgreementView[] = [];
    for (const ag of this.agreements.values()) {
      if (ag.endTick <= this.tick) continue;
      if (ag.a !== c.id && ag.b !== c.id) continue;
      const mine = ag.a === c.id;
      const other = this.city(mine ? ag.b : ag.a);
      if (other.status === 'ruins') continue;
      agreements.push({
        id: ag.id,
        counterparty: other.id,
        youGive: { ...(mine ? ag.aGives : ag.bGives) },
        youReceive: { ...(mine ? ag.bGives : ag.aGives) },
        ticksRemaining: ag.endTick - this.tick,
        deliveryDueNow: ag.startTick <= this.tick + 1 && this.tick + 1 < ag.endTick,
        yourFulfillment: { ...ag.fulfillment[c.id] },
        theirFulfillment: { ...ag.fulfillment[other.id] },
      });
    }

    return {
      tick: this.tick,
      you: {
        cityId: c.id,
        name: c.name,
        produces: [...c.produces] as [Resource, Resource],
        stockpiles: { ...c.stockpiles },
        stockpileCap: cap,
        production,
        consumption,
        population: c.population,
        unrest: c.unrest,
        status: c.status,
        ticksUntilShortage,
        forewarnings,
      },
      world: { cities: others, shocks: shockViews, publicEvents: this.events.filter((e) => e.isPublic).slice(-8) },
      ledger: { incomingOffers, outgoingOffers, agreements },
      inbox: this.inboxNow.get(c.id) ?? [],
      memory: this.memories.get(c.id) ?? '',
    };
  }

  private applyAction(c: City, action: SeatAction): void {
    if (typeof action.memory === 'string') this.memories.set(c.id, action.memory.slice(0, 4000));
    if (!this.config.tradeEnabled) return;

    if (action.policies?.embargo) {
      const prev = this.embargoes.get(c.id) ?? new Set<string>();
      const next = new Set(action.policies.embargo.filter((id) => id !== c.id && this.cities.some((o) => o.id === id)));
      for (const id of next) {
        if (!prev.has(id)) this.emit('embargo', `${c.name} declares an embargo on ${this.city(id).name}`, true, c.id, id);
      }
      this.embargoes.set(c.id, next);
    }

    for (const m of (action.messages ?? []).slice(0, 8)) {
      const target = this.cities.find((o) => o.id === m.to);
      if (!target || target.status === 'ruins' || target.id === c.id) continue;
      if (this.embargoes.get(target.id)?.has(c.id)) continue;
      const msg = { from: c.id, to: target.id, tick: this.tick, text: String(m.text).slice(0, 600) };
      const list = this.inboxNext.get(target.id) ?? [];
      list.push(msg);
      this.inboxNext.set(target.id, list);
      this.messageLog.push(msg);
    }

    let offerCount = 0;
    for (const o of action.offers ?? []) {
      if (offerCount >= this.config.trade.maxOffersPerTick) break;
      const target = this.cities.find((t) => t.id === o.to);
      if (!target || target.status === 'ruins' || target.id === c.id) continue;
      if (this.embargoes.get(target.id)?.has(c.id)) continue;
      if (!RESOURCES.includes(o.give?.resource as Resource) || !RESOURCES.includes(o.receive?.resource as Resource)) continue;
      const giveQty = Number(o.give.qty);
      const receiveQty = Number(o.receive.qty);
      if (!Number.isFinite(giveQty) || !Number.isFinite(receiveQty) || giveQty <= 0 || receiveQty <= 0) continue;
      const duration = Math.min(30, Math.max(1, Math.round(Number(o.duration) || 8)));
      const id = `o${++this.idCounter}`;
      this.offers.set(id, {
        id,
        from: c.id,
        to: target.id,
        give: { resource: o.give.resource, qty: giveQty },
        receive: { resource: o.receive.resource, qty: receiveQty },
        duration,
        createdTick: this.tick,
        expiresTick: this.tick + this.config.trade.offerTTL,
        status: 'open',
      });
      offerCount++;
    }

    for (const r of action.responses ?? []) {
      const offer = this.offers.get(r.offerId);
      if (!offer || offer.to !== c.id || offer.status !== 'open' || this.tick >= offer.expiresTick) continue;
      const from = this.city(offer.from);
      if (from.status === 'ruins') {
        offer.status = 'expired';
        continue;
      }
      if (r.decision === 'reject') {
        offer.status = 'rejected';
        continue;
      }
      offer.status = 'accepted';
      const id = `a${++this.idCounter}`;
      // start at tick+2 so both parties have seen the agreement before the
      // first delivery is due — otherwise the offerer starts one tick behind
      const startTick = this.tick + 2;
      this.agreements.set(id, {
        id,
        a: offer.from,
        b: offer.to,
        aGives: { ...offer.give },
        bGives: { ...offer.receive },
        startTick,
        endTick: startTick + offer.duration,
        fulfillment: {
          [offer.from]: { promised: 0, delivered: 0 },
          [offer.to]: { promised: 0, delivered: 0 },
        },
      });
      this.emit(
        'pact',
        `Pact: ${from.name} ships ${offer.give.qty} ${offer.give.resource}/t ⇄ ${c.name} ships ${offer.receive.qty} ${offer.receive.resource}/t for ${offer.duration}t`,
        true,
        offer.from,
        offer.to,
      );
    }

    for (const d of action.deliveries ?? []) {
      const ag = this.agreements.get(d.agreementId);
      if (!ag || (ag.a !== c.id && ag.b !== c.id)) continue;
      const qty = Number(d.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      this.pendingDeliveries.push({ cityId: c.id, agreementId: ag.id, qty });
    }
  }
}
