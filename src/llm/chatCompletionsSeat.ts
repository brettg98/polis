import fs from 'node:fs';
import path from 'node:path';
import type { Seat, SeatAction, SeatObservation } from '../engine/types';
import { SEAT_ACTION_SCHEMA } from './schema';
import { SYSTEM_PROMPT, observationToMessage } from './prompt';
import { validateSeatAction } from './validate';
import { ProviderError, retryAfterFrom, retryDelayMs, sleep } from './backoff';

export interface ChatCompletionsPrices {
  input: number; // $/MTok
  output: number;
  cachedRead?: number; // $/MTok for cached prompt tokens; falls back to input price
}

export interface ChatCompletionsSeatOptions {
  model: string;
  baseUrl: string; // e.g. https://opencode.ai/zen/v1 or https://api.openai.com/v1
  apiKeyEnv: string; // env var holding the key (resolved at launch, never stored)
  // Deliberation budget, the counterpart to AnthropicSeat's `effort`. Fairness
  // rule (docs/llm-seats.md): identical across seats, or the comparison
  // measures how long a provider is willing to think rather than how well.
  // Dropped automatically if a provider rejects it.
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokensPerCall?: number;
  tokenBudget?: number;
  logFile?: string;
  prices?: ChatCompletionsPrices;
}

export interface ChatCompletionsUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

// Defined by a protocol rather than a vendor: anything that speaks
// /chat/completions. Three providers use it today and more can without touching
// this file, which is why it is not named after any of them — `AnthropicSeat`
// next door genuinely is vendor-specific (that vendor's SDK, its Messages API),
// and the naming should make that distinction visible rather than hide it.
//
// Speaking the protocol is not the same as behaving alike. Capability
// differences are probed once and remembered: response_format json_schema →
// json_object fallback, and max_tokens → max_completion_tokens for
// reasoning-model APIs. Providers also diverge in what they honour versus
// merely accept — see EFFORT in factory.ts. The fairness retry rule (one retry,
// then pass) is identical to the Anthropic seat.
export class ChatCompletionsSeat implements Seat {
  readonly cityId: string;
  readonly label: string;
  readonly usage: ChatCompletionsUsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  readonly stats = { retries: 0, failures: 0, adaptations: 0, latencies: [] as number[] };

  private opts: ChatCompletionsSeatOptions;
  private apiKey: string;
  private mode: 'json_schema' | 'json_object' = 'json_schema';
  private tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
  private sendEffort = true; // cleared if the provider rejects reasoning_effort
  private budgetWarned = false;

  constructor(cityId: string, opts: ChatCompletionsSeatOptions) {
    this.cityId = cityId;
    this.opts = opts;
    this.label = `${new URL(opts.baseUrl).hostname}:${opts.model}`;
    const key = process.env[opts.apiKeyEnv];
    if (!key) throw new Error(`${opts.apiKeyEnv} is not set (needed for seat ${this.label})`);
    this.apiKey = key;
    if (opts.logFile) fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  }

  // A FLOOR, not a measurement. Gateways differ in what they report: GLM
  // counts reasoning inside completion_tokens, Zen's GPT 5.6 route does not
  // (mean 694 reported output tokens/call vs GLM's 6467 for the same task),
  // so Terra's true billed output exceeds what we can see. Verified against
  // provider invoices 2026-07-26: Anthropic seats reconcile within 3% and
  // GLM within 9%, but Terra's invoice ran 33% above this number. Never
  // publish a cross-vendor cost ranking off it alone.
  estimatedCost(): number {
    const p = this.opts.prices;
    if (!p) return 0;
    const cachedRate = p.cachedRead ?? p.input;
    const freshInput = Math.max(0, this.usage.inputTokens - this.usage.cachedTokens);
    return (freshInput * p.input + this.usage.cachedTokens * cachedRate + this.usage.outputTokens * p.output) / 1_000_000;
  }

  private budgetExceeded(): boolean {
    if (!this.opts.tokenBudget) return false;
    return this.usage.inputTokens + this.usage.outputTokens >= this.opts.tokenBudget;
  }

  private log(entry: Record<string, unknown>): void {
    if (!this.opts.logFile) return;
    fs.appendFileSync(
      this.opts.logFile,
      JSON.stringify({ ts: new Date().toISOString(), seat: this.cityId, model: this.opts.model, ...entry }) + '\n',
    );
  }

  private systemPrompt(): string {
    // json_object mode has no server-side schema enforcement, so the schema
    // rides in the prompt. Stable per seat → still a cacheable prefix.
    if (this.mode === 'json_object') {
      return `${SYSTEM_PROMPT}\n\n# Action schema (respond with JSON matching exactly this)\n${JSON.stringify(SEAT_ACTION_SCHEMA)}`;
    }
    return SYSTEM_PROMPT;
  }

  private buildBody(obs: SeatObservation, feedback?: string): Record<string, unknown> {
    const responseFormat =
      this.mode === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: 'seat_action', strict: true, schema: SEAT_ACTION_SCHEMA } }
        : { type: 'json_object' };
    const user = feedback
      ? `${observationToMessage(obs)}\n\nYour previous reply this tick was invalid: ${feedback}. Return the complete corrected action JSON matching the schema exactly.`
      : observationToMessage(obs);
    return {
      model: this.opts.model,
      // 16K default: reasoning models (GLM) spend hidden reasoning from this
      // budget and were truncating mid-JSON at 8K. Identical across seats.
      [this.tokenParam]: this.opts.maxTokensPerCall ?? 16000,
      ...(this.sendEffort && this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
      response_format: responseFormat,
      messages: [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: user },
      ],
    };
  }

  private async call(obs: SeatObservation, adaptationsLeft: number, feedback?: string): Promise<SeatAction> {
    // Wall time for this HTTP round trip. Each adaptation retry recurses and
    // times its own fetch, so every billable call is measured separately.
    // Matters most here: this gateway does not report reasoning tokens for the
    // GPT route while billing for them, so time is the only independent signal
    // of how much work actually happened (docs/llm-seats.md).
    const started = Date.now();
    const resp = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(this.buildBody(obs, feedback)),
      signal: AbortSignal.timeout(300_000), // matched across seats; GLM crisis-tick reasoning exceeds 120s at 16K budget
    });

    if (!resp.ok) {
      const errText = (await resp.text()).slice(0, 500);
      if (adaptationsLeft > 0 && resp.status === 400) {
        if (this.tokenParam === 'max_tokens' && /max_completion_tokens/i.test(errText)) {
          this.tokenParam = 'max_completion_tokens';
          this.stats.adaptations++;
          this.log({ tick: obs.tick, adapted: 'max_completion_tokens' });
          return this.call(obs, adaptationsLeft - 1, feedback);
        }
        if (this.mode === 'json_schema' && /response_format|json_schema/i.test(errText)) {
          this.mode = 'json_object';
          this.stats.adaptations++;
          this.log({ tick: obs.tick, adapted: 'json_object' });
          return this.call(obs, adaptationsLeft - 1, feedback);
        }
        // Only GLM 5.2 documents reasoning_effort on Z.ai, and older models
        // elsewhere may reject it. Drop it rather than fail the seat — but log
        // it, because a seat running without an effort cap is not playing
        // under the same rules as the others.
        if (this.sendEffort && /reasoning_effort/i.test(errText)) {
          this.sendEffort = false;
          this.stats.adaptations++;
          this.log({ tick: obs.tick, adapted: 'reasoning_effort dropped (rejected by provider)' });
          return this.call(obs, adaptationsLeft - 1, feedback);
        }
      }
      // Carry the status and any Retry-After through to the retry policy;
      // a bare message would leave it guessing from the text.
      throw new ProviderError(`HTTP ${resp.status}: ${errText}`, resp.status, retryAfterFrom(resp.headers));
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    const ms = Date.now() - started;
    this.stats.latencies.push(ms);
    this.usage.calls++;
    this.usage.inputTokens += data.usage?.prompt_tokens ?? 0;
    this.usage.outputTokens += data.usage?.completion_tokens ?? 0;
    this.usage.cachedTokens += data.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      this.log({ tick: obs.tick, refusal: true });
      return {};
    }
    const content = choice?.message?.content;
    if (!content) throw new Error(`empty content (finish_reason: ${choice?.finish_reason})`);
    let action: SeatAction;
    try {
      action = JSON.parse(content) as SeatAction;
    } catch (err) {
      // Content that isn't even JSON means response_format was ignored
      // outright — the provider returned prose or a markdown-fenced block.
      // Observed on Z.ai direct, which accepts json_schema with a 200 and
      // discards it. Adapt here too, or the parse throws before the
      // validation branch below is ever reached and the seat never learns.
      if (this.mode === 'json_schema') {
        this.mode = 'json_object';
        this.stats.adaptations++;
        this.log({ tick: obs.tick, adapted: 'json_object (schema ignored, output unparseable)' });
      }
      this.log({ tick: obs.tick, parse_error: String(err), finish_reason: choice?.finish_reason, usage: data.usage, content_head: content.slice(0, 200) });
      throw new Error(`unparseable content (finish_reason: ${choice?.finish_reason}): ${String(err)}`);
    }
    const problems = validateSeatAction(action);
    if (problems.length) {
      // Valid JSON of the wrong shape means the schema was accepted but not
      // enforced — observed on the gateway's GPT route. Same remedy.
      if (this.mode === 'json_schema') {
        this.mode = 'json_object';
        this.stats.adaptations++;
        this.log({ tick: obs.tick, adapted: 'json_object (schema silently unenforced)' });
      }
      this.log({ tick: obs.tick, invalid_action: action, problems });
      throw new Error(`invalid action: ${problems.join('; ')}`);
    }
    this.log({ tick: obs.tick, ms, usage: data.usage, finish_reason: choice?.finish_reason, action });
    return action;
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
    // Fairness rule (docs/llm-seats.md): one retry with the validation errors
    // fed back, then pass the tick. Capability adaptations don't consume it.
    let feedback: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.call(obs, 2, feedback);
      } catch (err) {
        this.log({ tick: obs.tick, attempt, error: String(err) });
        feedback = String(err).slice(0, 600);
        if (attempt === 0) {
          this.stats.retries++;
          // Identical policy in anthropicSeat.ts; both call the same helper so
          // no provider gets a longer grace period than another.
          const wait = retryDelayMs(err);
          if (wait > 0) {
            this.log({ tick: obs.tick, attempt, retry_delay_ms: wait });
            await sleep(wait);
          }
        }
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
