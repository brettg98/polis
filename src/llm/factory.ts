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

export interface SeatFactoryOptions {
  logDir: string;
  tokenBudget?: number;
  runId: string;
}

// Seat specs are strings so lineups stay config, not code:
//   anthropic:claude-opus-5      Anthropic API (ANTHROPIC_API_KEY)
//   anthropic:claude-sonnet-5
//   opencode:glm-5.2             OpenCode Zen gateway (OPENCODE_API_KEY)
//   opencode:gpt-5.5             GPT via Zen (same account)
//   openai:gpt-5.5               OpenAI direct (OPENAI_API_KEY)
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
        effort: 'low',
        tokenBudget: opts.tokenBudget,
        logFile,
      });
    case 'opencode':
      return new OpenAICompatSeat(cityId, {
        model,
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKeyEnv: 'OPENCODE_API_KEY',
        tokenBudget: opts.tokenBudget,
        logFile,
        prices: OPENCODE_PRICES[model],
      });
    case 'openai':
      return new OpenAICompatSeat(cityId, {
        model,
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        tokenBudget: opts.tokenBudget,
        logFile,
      });
    default:
      throw new Error(`unknown provider "${provider}" in seat spec "${spec}"`);
  }
}
