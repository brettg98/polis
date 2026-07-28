import type { RNG } from '../rng';
import { RESOURCES, Resource, Seat, SeatAction, SeatObservation, zeroResources } from '../types';

const round1 = (x: number): number => Math.round(x * 10) / 10;

// Heuristic stand-in for an LLM seat. Honest seats deliver what they promised
// and retaliate proportionally against chronic shorting (tit-for-tat).
// Opportunists defect under stress or on a whim.
export class ScriptedSeat implements Seat {
  readonly cityId: string;
  readonly label: string;
  private personality: 'honest' | 'opportunist';
  private rng: RNG;
  private shrink = new Map<string, number>(); // per-target ask reduction after rejections
  private lastOfferTargets = new Set<string>();

  constructor(cityId: string, personality: 'honest' | 'opportunist', rng: RNG) {
    this.cityId = cityId;
    this.personality = personality;
    this.label = `scripted-${personality}`;
    this.rng = rng;
  }

  async getAction(obs: SeatObservation): Promise<SeatAction> {
    const you = obs.you;
    const deficit = RESOURCES.find((r) => !you.produces.includes(r))!;
    const action: Required<Pick<SeatAction, 'offers' | 'responses' | 'deliveries' | 'messages'>> = {
      offers: [],
      responses: [],
      deliveries: [],
      messages: [],
    };

    // learn from last tick's offers: rejected → ask for less next time
    for (const target of this.lastOfferTargets) {
      const stillOpen = obs.ledger.outgoingOffers.some((o) => o.to === target);
      const agreed = obs.ledger.agreements.some((a) => a.counterparty === target && a.ticksRemaining > 0);
      if (agreed) this.shrink.delete(target);
      else if (!stillOpen) this.shrink.set(target, Math.max(0.4, (this.shrink.get(target) ?? 1) * 0.7));
    }

    // deliveries
    for (const ag of obs.ledger.agreements) {
      if (!ag.deliveryDueNow) continue;
      const due = ag.youGive.qty;
      const theirRatio = ag.theirFulfillment.promised > 0 ? ag.theirFulfillment.delivered / ag.theirFulfillment.promised : 1;
      let qty = due;
      if (theirRatio < 0.55) qty = due * theirRatio;
      if (this.personality === 'opportunist') {
        const stressed = you.stockpiles[deficit] < you.stockpileCap * 0.15;
        if (stressed || this.rng.next() < 0.12) qty = 0;
      }
      const reserve = you.consumption[ag.youGive.resource] * 2;
      qty = Math.min(qty, Math.max(0, you.stockpiles[ag.youGive.resource] - reserve));
      if (qty > 0) action.deliveries.push({ agreementId: ag.id, qty });
    }

    // committed flows from agreements still in force (including pending-start)
    const inflow = zeroResources();
    const outflow = zeroResources();
    for (const ag of obs.ledger.agreements) {
      if (ag.ticksRemaining <= 0) continue;
      outflow[ag.youGive.resource] += ag.youGive.qty;
      inflow[ag.youReceive.resource] += ag.youReceive.qty;
    }

    // respond to incoming offers (offer fields are the sender's perspective)
    for (const off of obs.ledger.incomingOffers) {
      const iGive = off.receive;
      const iGet = off.give;
      const producesIt = you.produces.includes(iGive.resource);
      const surplus = you.production[iGive.resource] - you.consumption[iGive.resource] - outflow[iGive.resource];
      const useful = iGet.resource === deficit || you.stockpiles[iGet.resource] < you.stockpileCap * 0.3;
      const fair = iGet.qty >= iGive.qty * 0.75;
      const accept = producesIt && useful && fair && iGive.qty <= surplus + 0.001;
      action.responses.push({ offerId: off.id, decision: accept ? 'accept' : 'reject' });
      if (accept) {
        outflow[iGive.resource] += iGive.qty;
        inflow[iGet.resource] += iGet.qty;
      }
    }

    // seek coverage for the deficit resource
    this.lastOfferTargets = new Set();
    const need = you.consumption[deficit];
    if (inflow[deficit] < need * 0.95) {
      const gap = need - inflow[deficit];
      const desperate = (you.ticksUntilShortage[deficit] ?? 99) < 6;
      const alreadyAsked = new Set(obs.ledger.outgoingOffers.map((o) => o.to));
      const targets = obs.world.cities
        .filter((c) => c.status !== 'ruins' && c.produces.includes(deficit) && !alreadyAsked.has(c.cityId))
        .sort((p, q) => this.targetScore(q.produces, you.produces) - this.targetScore(p.produces, you.produces))
        .slice(0, 2);
      for (const t of targets) {
        const shrink = this.shrink.get(t.cityId) ?? 1;
        const ask = round1(Math.max(1, (gap / Math.max(1, targets.length)) * shrink));
        // lead with what the counterparty is missing — deals close faster
        const theirDeficit = RESOURCES.find((r) => !t.produces.includes(r))!;
        const giveRes: Resource = you.produces.includes(theirDeficit)
          ? theirDeficit
          : you.stockpiles[you.produces[0]] >= you.stockpiles[you.produces[1]]
            ? you.produces[0]
            : you.produces[1];
        const ratio = desperate ? 1.4 : 1.0;
        action.offers.push({
          to: t.cityId,
          give: { resource: giveRes, qty: round1(ask * ratio) },
          receive: { resource: deficit, qty: ask },
          duration: 12,
        });
        this.lastOfferTargets.add(t.cityId);
        if (desperate) {
          action.messages.push({ to: t.cityId, text: `${you.name} is close to a ${deficit} shortage and needs this deal.` });
        }
      }
    }
    return action;
  }

  private targetScore(theirProduces: readonly Resource[], myProduces: readonly Resource[]): number {
    const theirDeficit = RESOURCES.find((r) => !theirProduces.includes(r))!;
    return (myProduces.includes(theirDeficit) ? 1 : 0) + this.rng.next() * 0.3;
  }
}

export class NullSeat implements Seat {
  readonly label = 'null';
  constructor(readonly cityId: string) {}
  async getAction(): Promise<SeatAction> {
    return {};
  }
}
