import path from 'node:path';
import { AnthropicSeat } from './anthropicSeat';
import { OpenAICompatSeat, type CompatPrices } from './openaiCompatSeat';

export type LLMSeat = AnthropicSeat | OpenAICompatSeat;

// $/MTok for gateway models where we know pricing (cost readouts only;
// unknown models report $0 and the JSONL log still has exact token counts).
const OPENCODE_PRICES: Record<string, CompatPrices> = {
  'glm-5.2': { input: 1.4, output: 4.4, cachedRead: 0.26 },
  'gpt-5.6-sol': { input: 5, output: 30, cachedRead: 0.5 },
  'gpt-5.6-terra': { input: 2.5, output: 15, cachedRead: 0.25 },
  'gpt-5.6-luna': { input: 1, output: 6, cachedRead: 0.1 },
};

// Z.ai list pricing. Identical to what the gateway charges for the same model,
// because the gateway resells at cost — which is also why it caps throughput on
// token-hungry models and this route exists at all.
const ZAI_PRICES: Record<string, CompatPrices> = {
  'glm-5.2': { input: 1.4, output: 4.4, cachedRead: 0.26 },
  'glm-5.1': { input: 1.4, output: 4.4, cachedRead: 0.26 },
  'glm-5': { input: 1.4, output: 4.4, cachedRead: 0.26 },
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
//
// GLM goes direct because the gateway caps it: measured at ~170 output tokens
// per minute against the ~2,800 a rotation needs, which stalled four runs.
// Models with a lighter appetite (GPT ~688 output tokens per call against GLM's
// ~4,669) never approach that cap and stay on the gateway.
// Deliberation budget, identical across every seat — the fairness rule in
// docs/llm-seats.md. Without it each provider runs at its own default and the
// benchmark measures how long a vendor is willing to think rather than how
// well: Anthropic seats were capped at 'low' from the start while GPT ran at
// its 'medium' default and GLM ran near maximum, spending 93-96% of a 16K
// budget on reasoning until it began exhausting it mid-run.
const REASONING_EFFORT = 'low' as const;

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
        effort: REASONING_EFFORT,
        tokenBudget: opts.tokenBudget,
        logFile,
      });
    case 'opencode':
      return new OpenAICompatSeat(cityId, {
        model,
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKeyEnv: 'OPENCODE_API_KEY',
        reasoningEffort: REASONING_EFFORT,
        tokenBudget: opts.tokenBudget,
        logFile,
        prices: OPENCODE_PRICES[model],
      });
    case 'zai':
      return new OpenAICompatSeat(cityId, {
        model,
        baseUrl: 'https://api.z.ai/api/paas/v4',
        apiKeyEnv: 'ZAI_API_KEY',
        reasoningEffort: REASONING_EFFORT,
        tokenBudget: opts.tokenBudget,
        logFile,
        prices: ZAI_PRICES[model],
      });
    case 'openai':
      return new OpenAICompatSeat(cityId, {
        model,
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        reasoningEffort: REASONING_EFFORT,
        tokenBudget: opts.tokenBudget,
        logFile,
      });
    default:
      throw new Error(`unknown provider "${provider}" in seat spec "${spec}"`);
  }
}
