import { RESOURCES } from '../engine/types';

const RES = new Set<string>(RESOURCES as readonly string[]);
const KNOWN = new Set(['deliveries', 'responses', 'offers', 'messages', 'memory', 'policies']);

// Client-side action validation — the uniform fairness layer. Server-side
// schema enforcement varies by provider (and gateways can silently drop
// response_format), so every action is checked here regardless of transport.
// Failures trigger the one fairness retry with these messages fed back.
export function validateSeatAction(a: unknown): string[] {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return ['action must be a JSON object'];
  const o = a as Record<string, unknown>;
  const p: string[] = [];
  for (const k of Object.keys(o)) {
    if (!KNOWN.has(k)) p.push(`unknown field "${k}" — did you mean one of deliveries/responses/offers/messages?`);
  }
  const arr = (k: string): unknown[] => {
    if (o[k] === undefined) {
      p.push(`missing "${k}" (use an empty array when there is nothing to do)`);
      return [];
    }
    if (!Array.isArray(o[k])) {
      p.push(`"${k}" must be an array`);
      return [];
    }
    return o[k] as unknown[];
  };
  const resQty = (v: unknown, where: string): void => {
    const x = v as Record<string, unknown> | null;
    if (typeof x?.resource !== 'string' || !RES.has(x.resource)) p.push(`${where}.resource must be one of food/energy/materials`);
    if (typeof x?.qty !== 'number' || !Number.isFinite(x.qty) || x.qty <= 0) p.push(`${where}.qty must be a positive number`);
  };

  arr('deliveries').forEach((d, i) => {
    const x = d as Record<string, unknown>;
    if (typeof x?.agreementId !== 'string') p.push(`deliveries[${i}].agreementId must be a string`);
    if (typeof x?.qty !== 'number' || !Number.isFinite(x.qty)) p.push(`deliveries[${i}].qty must be a number`);
  });
  arr('responses').forEach((r, i) => {
    const x = r as Record<string, unknown>;
    if (typeof x?.offerId !== 'string') p.push(`responses[${i}].offerId must be a string`);
    if (x?.decision !== 'accept' && x?.decision !== 'reject') p.push(`responses[${i}].decision must be "accept" or "reject"`);
  });
  arr('offers').forEach((of, i) => {
    const x = of as Record<string, unknown>;
    if (typeof x?.to !== 'string') p.push(`offers[${i}].to must be a city id string`);
    resQty(x?.give, `offers[${i}].give`);
    resQty(x?.receive, `offers[${i}].receive`);
    if (typeof x?.duration !== 'number' || !Number.isFinite(x.duration)) p.push(`offers[${i}].duration must be a number of ticks`);
  });
  arr('messages').forEach((m, i) => {
    const x = m as Record<string, unknown>;
    if (typeof x?.to !== 'string') p.push(`messages[${i}].to must be a city id string`);
    if (typeof x?.text !== 'string') p.push(`messages[${i}].text must be a string`);
  });
  // "policies" is tolerated but not in SEAT_ACTION_SCHEMA, so it only ever
  // arrives from a provider that ignored the schema (the json_object fallback
  // path). sim.ts filters policies.embargo directly, so an invented non-array
  // there throws mid-tick and ends the run. Validate the shape rather than
  // trusting the field name. Deliberately not added to the schema: that would
  // advertise an embargo capability the tournament-1 lineup never saw.
  if (o.policies !== undefined) {
    const pol = o.policies;
    if (typeof pol !== 'object' || pol === null || Array.isArray(pol)) {
      p.push('"policies" must be an object');
    } else {
      const emb = (pol as Record<string, unknown>).embargo;
      if (emb !== undefined) {
        if (!Array.isArray(emb)) p.push('"policies.embargo" must be an array of city id strings');
        else if (emb.some((id) => typeof id !== 'string')) p.push('"policies.embargo" entries must be city id strings');
      }
    }
  }
  if (o.memory === undefined) p.push('missing "memory" (return your updated journal string)');
  else if (typeof o.memory !== 'string') p.push('"memory" must be a string');
  return p;
}
