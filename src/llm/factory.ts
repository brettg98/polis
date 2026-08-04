import path from 'node:path';
import { AnthropicSeat } from './anthropicSeat';
import { ChatCompletionsSeat, type ChatCompletionsPrices } from './chatCompletionsSeat';

export type LLMSeat = AnthropicSeat | ChatCompletionsSeat;

// $/MTok for gateway models where we know pricing (cost readouts only;
// unknown models report $0 and the JSONL log still has exact token counts).
const OPENCODE_PRICES: Record<string, ChatCompletionsPrices> = {
  'glm-5.2': { input: 1.4, output: 4.4, cachedRead: 0.26 },
  'gpt-5.6-sol': { input: 5, output: 30, cachedRead: 0.5 },
  'gpt-5.6-terra': { input: 2.5, output: 15, cachedRead: 0.25 },
  'gpt-5.6-luna': { input: 1, output: 6, cachedRead: 0.1 },
};

// OpenAI list pricing, from developers.openai.com/api/docs/pricing.
// Worth reading against OPENCODE_PRICES above: the gateway's margin is not a
// flat markup. It resells sol at cost, terra at 1.25x, and luna at 5x. "The
// gateway earns nothing on tokens" holds for sol and for GLM; it is false for
// the other two, so a route change moves the cost figures as well as the
// reported usage.
// These are the standard rates. Requests over 272K input tokens bill at double;
// a POLIS observation is ~4K, so that tier is unreachable here.
const OPENAI_PRICES: Record<string, ChatCompletionsPrices> = {
  'gpt-5.6-sol': { input: 5, output: 30, cachedRead: 0.5 },
  'gpt-5.6-terra': { input: 2, output: 12, cachedRead: 0.2 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cachedRead: 0.02 },
};

// Z.ai list pricing. Identical to what the gateway charges for the same model,
// because the gateway resells GLM at cost — which is also why it caps
// throughput on token-hungry models and this route exists at all.
const ZAI_PRICES: Record<string, ChatCompletionsPrices> = {
  'glm-5.2': { input: 1.4, output: 4.4, cachedRead: 0.26 },
  'glm-5.1': { input: 1.4, output: 4.4, cachedRead: 0.26 },
  'glm-5': { input: 1.4, output: 4.4, cachedRead: 0.26 },
};

// Moonshot list pricing, from platform.kimi.ai/docs/pricing/chat-k3. Flat, no
// context tier. The international (.ai) and China (.cn) platforms bill from
// separate balances and do not sync; this is the .ai one.
const MOONSHOT_PRICES: Record<string, ChatCompletionsPrices> = {
  'kimi-k3': { input: 3, output: 15, cachedRead: 0.3 },
};

export interface SeatFactoryOptions {
  logDir: string;
  tokenBudget?: number;
  runId: string;
}

// Seat specs are strings so lineups stay config, not code:
//   anthropic:claude-opus-5      Anthropic API (ANTHROPIC_API_KEY)
//   anthropic:claude-sonnet-5
//   zai:glm-5.2                  Z.ai direct (ZAI_API_KEY)
//   opencode:gpt-5.5             GPT via the OpenCode Zen gateway (OPENCODE_API_KEY)
//   openai:gpt-5.5               OpenAI direct (OPENAI_API_KEY)
//   moonshot:kimi-k3             Moonshot direct, .ai not .cn (MOONSHOT_API_KEY)
//
// GLM goes direct because the gateway caps it: measured at ~170 output tokens
// per minute against the ~2,800 a rotation needs, which stalled four runs.
// Models with a lighter appetite (GPT ~688 output tokens per call against GLM's
// ~4,669) never approach that cap and stay on the gateway.

// Deliberation setting, per provider. Deliberately NOT one value for every seat,
// which is what this was until 2026-08-02 and what the fairness rule used to
// require. An identical label does not buy identical deliberation: each vendor
// defines and calibrates its own effort ladder. Measured on real tournament
// ticks (issue #21), at an identical 'low' the Anthropic seats spend 753-1,563
// output tokens per call and glm-5.2 spends 8,771-11,814 — an order of
// magnitude, from the same string.
//
// So every entry here is a calibration claim about that provider, backed by a
// measurement, not a preference. What the benchmark now holds is a bound on
// measured output tokens (docs/llm-seats.md); changing an entry without
// re-measuring breaks that bound silently, because a provider that accepts a
// value and ignores it looks exactly like one that honoured it.
//
// Re-measure with: npx tsx scripts/effort-probe.ts
const EFFORT = {
  // Honoured. low/high/max are monotonic and steep on both Opus 5 and Sonnet 5.
  // Measured 753 ± 89 to 1,563 ± 340 output tokens per call, n=6 per cell.
  anthropic: 'low',
  // 'none' because 'low' is not a floor here — Z.ai maps low and medium onto
  // high for glm-5.2, which is how tournaments 1 and 2 ended up with GLM
  // deliberating ~10x the Anthropic seats while nominally matched. Measured
  // 591 ± 87 to 863 ± 168, n=6. Lands below the Anthropic seats rather than
  // level with them; nothing on the ladder sits in between (ADR-006).
  zai: 'none',
  // UNVERIFIABLE on this route, not merely unmeasured. The gateway returns
  // reasoning_tokens: 0 for the GPT route while billing for them, so the
  // quantity the bound is defined on is under-reported by construction. Any
  // seat that has to satisfy ADR-006 belongs on a direct route; this value is
  // whatever the gateway does with it. Terra played 289 ticks of tournament 2
  // here.
  opencode: 'low',
  // Measured 567 ± 127 quiet to 899 ± 356 crisis on gpt-5.6-terra, n=5.
  // `none` was tried and rejected: it flattens the seat to 323/353, a +9%
  // response to a harder tick where every other seat gives +46% to +74%, and it
  // puts the fleet 4.4x apart on the crisis observation — outside the bound.
  // `medium` also fits; `low` is chosen because it matches Sonnet's slope
  // exactly (+59%) and costs less.
  openai: 'low',
  // PROVISIONAL, n=1 — the only entry here not backed by the n=5 ladder probe.
  // kimi-k3's ladder is low/high/max with thinking permanently on, so `low` is
  // the floor and there is nothing below it to fall back to. On the #33 fleet
  // audit, one identical observation, it spent 323 output tokens at `low`
  // against Terra's 324, Opus's 456 and GLM's 494 — the joint-lowest seat, not
  // the highest, which is what the concern in #32 assumed. That predicts a
  // 1.53x fleet spread, comfortably inside the bound, which is the pre-run
  // check ADR-006 actually requires. Still owed: the n=5 two-tick measurement,
  // because a probe figure is known to under-predict run conditions here (the
  // ADR-006 second amendment records it missing GLM by roughly half).
  moonshot: 'low',
} as const;

export function createLLMSeat(spec: string, cityId: string, opts: SeatFactoryOptions): LLMSeat {
  const sep = spec.indexOf(':');
  if (sep < 0) throw new Error(`seat spec "${spec}" must be provider:model`);
  const provider = spec.slice(0, sep);
  const model = spec.slice(sep + 1);
  const logFile = path.join(opts.logDir, `${opts.runId}-${cityId}-${model.replace(/[^a-z0-9.-]/gi, '_')}.jsonl`);

  switch (provider) {
    case 'anthropic':
      return new AnthropicSeat(cityId, {
        model,
        effort: EFFORT.anthropic,
        tokenBudget: opts.tokenBudget,
        logFile,
      });
    case 'opencode':
      return new ChatCompletionsSeat(cityId, {
        model,
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKeyEnv: 'OPENCODE_API_KEY',
        reasoningEffort: EFFORT.opencode,
        tokenBudget: opts.tokenBudget,
        logFile,
        prices: OPENCODE_PRICES[model],
      });
    case 'zai':
      return new ChatCompletionsSeat(cityId, {
        model,
        baseUrl: 'https://api.z.ai/api/paas/v4',
        apiKeyEnv: 'ZAI_API_KEY',
        reasoningEffort: EFFORT.zai,
        tokenBudget: opts.tokenBudget,
        logFile,
        prices: ZAI_PRICES[model],
      });
    case 'openai':
      return new ChatCompletionsSeat(cityId, {
        model,
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        reasoningEffort: EFFORT.openai,
        tokenBudget: opts.tokenBudget,
        logFile,
        prices: OPENAI_PRICES[model],
      });
    case 'moonshot':
      return new ChatCompletionsSeat(cityId, {
        model,
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKeyEnv: 'MOONSHOT_API_KEY',
        reasoningEffort: EFFORT.moonshot,
        tokenBudget: opts.tokenBudget,
        logFile,
        prices: MOONSHOT_PRICES[model],
      });
    default:
      throw new Error(`unknown provider "${provider}" in seat spec "${spec}"`);
  }
}
