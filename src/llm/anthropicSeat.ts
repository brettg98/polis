import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Seat, SeatAction, SeatObservation } from '../engine/types';
import { SEAT_ACTION_SCHEMA } from './schema';
import { SYSTEM_PROMPT, observationToMessage } from './prompt';
import { validateSeatAction } from './validate';

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AnthropicSeatOptions {
  model: string;
  effort?: 'low' | 'medium' | 'high';
  maxTokensPerCall?: number;
  tokenBudget?: number; // total across the run; exceeded → seat passes remaining ticks
  logFile?: string; // JSONL call log (replay record + cost ledger)
}

// $/MTok for cost estimates. Cache reads bill at 0.1x input, writes at 1.25x.
// Sonnet 5 is on introductory pricing ($2/$10 vs list $3/$15) through
// 2026-08-31; revert to 3/15 after that date or costs will read 33% low.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export class AnthropicSeat implements Seat {
  readonly cityId: string;
  readonly label: string;
  readonly usage: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  readonly stats = { retries: 0, failures: 0, adaptations: 0, latencies: [] as number[] };

  private client: Anthropic;
  private opts: AnthropicSeatOptions;
  private budgetWarned = false;

  constructor(cityId: string, opts: AnthropicSeatOptions) {
    this.cityId = cityId;
    this.opts = opts;
    this.label = `anthropic:${opts.model}`;
    this.client = new Anthropic({ timeout: 300_000 }); // matched across seats (fairness: identical timeout)
    if (opts.logFile) fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  }

  estimatedCost(): number {
    const p = PRICES[this.opts.model] ?? { input: 5, output: 25 };
    return (
      (this.usage.inputTokens * p.input +
        this.usage.cacheWriteTokens * p.input * 1.25 +
        this.usage.cacheReadTokens * p.input * 0.1 +
        this.usage.outputTokens * p.output) /
      1_000_000
    );
  }

  private budgetExceeded(): boolean {
    if (!this.opts.tokenBudget) return false;
    const total =
      this.usage.inputTokens + this.usage.outputTokens + this.usage.cacheReadTokens + this.usage.cacheWriteTokens;
    return total >= this.opts.tokenBudget;
  }

  private log(entry: Record<string, unknown>): void {
    if (!this.opts.logFile) return;
    fs.appendFileSync(this.opts.logFile, JSON.stringify({ ts: new Date().toISOString(), seat: this.cityId, ...entry }) + '\n');
  }

  async getAction(obs: SeatObservation): Promise<SeatAction> {
    if (this.budgetExceeded()) {
      if (!this.budgetWarned) {
        this.budgetWarned = true;
        console.warn(`[${this.label}] token budget exhausted at tick ${obs.tick}; passing remaining ticks`);
        this.log({ tick: obs.tick, event: 'budget_exhausted' });
      }
      return {};
    }

    // Haiku 4.5 doesn't accept the effort parameter.
    const effort = this.opts.model.startsWith('claude-haiku') ? undefined : this.opts.effort;

    // Fairness rule (docs/llm-seats.md): one retry with validation errors fed
    // back, then the seat passes the tick.
    let feedback: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const params = {
        model: this.opts.model,
        max_tokens: this.opts.maxTokensPerCall ?? 16000, // matched to compat seats (fairness: identical ceiling)
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        output_config: {
          format: { type: 'json_schema', schema: SEAT_ACTION_SCHEMA },
          ...(effort ? { effort } : {}),
        },
        messages: [
          {
            role: 'user',
            content: feedback
              ? `${observationToMessage(obs)}\n\nYour previous reply this tick was invalid: ${feedback}. Return the complete corrected action JSON matching the schema exactly.`
              : observationToMessage(obs),
          },
        ],
      };
      // Wall time for this call. Cannot be recovered afterwards: seats run in
      // parallel and the tick waits for the slowest, so a seat's log
      // timestamps only ever show the slowest seat's pace, not its own.
      const started = Date.now();
      try {
        const resp = (await this.client.messages.create(
          params as unknown as Anthropic.MessageCreateParamsNonStreaming,
        )) as Anthropic.Message;
        const ms = Date.now() - started;
        this.stats.latencies.push(ms);

        this.usage.calls++;
        this.usage.inputTokens += resp.usage.input_tokens ?? 0;
        this.usage.outputTokens += resp.usage.output_tokens ?? 0;
        this.usage.cacheReadTokens += resp.usage.cache_read_input_tokens ?? 0;
        this.usage.cacheWriteTokens += resp.usage.cache_creation_input_tokens ?? 0;

        if (resp.stop_reason === 'refusal') {
          this.log({ tick: obs.tick, attempt, stop_reason: 'refusal' });
          return {};
        }
        const text = resp.content.find(
          (b): b is Anthropic.TextBlock => b.type === 'text',
        );
        if (!text) throw new Error(`no text block (stop_reason: ${resp.stop_reason})`);
        const action = JSON.parse(text.text) as SeatAction;
        const problems = validateSeatAction(action);
        if (problems.length) {
          this.log({ tick: obs.tick, attempt, invalid_action: action, problems });
          throw new Error(`invalid action: ${problems.join('; ')}`);
        }
        this.log({ tick: obs.tick, attempt, ms, stop_reason: resp.stop_reason, usage: resp.usage, action });
        return action;
      } catch (err) {
        this.log({ tick: obs.tick, attempt, ms: Date.now() - started, error: String(err) });
        feedback = String(err).slice(0, 600);
        if (attempt === 0) this.stats.retries++;
        if (attempt === 1) {
          this.stats.failures++;
          console.warn(`[${this.label}] tick ${obs.tick}: both attempts failed, passing (${String(err).slice(0, 200)})`);
          return {};
        }
      }
    }
    return {};
  }
}
