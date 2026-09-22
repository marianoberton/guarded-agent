import { postJson, type RetryOptions } from "./http.js";
import { RateLimiter } from "./rateLimit.js";
import { ProviderError } from "./types.js";
import type { Answers, QuestionMap } from "../classify/types.js";

/**
 * Jev (TypeSafe System One) through OpenRouter's Decisions endpoint.
 *
 * Jev is not a chat model: it takes no `messages` and returns no text. It takes
 * a `state` and a map of typed questions and returns calibrated answers. Chat
 * completion SDKs do not work against this endpoint — hence a separate client
 * rather than a second model id on OpenRouterProvider.
 *
 * Every question is evaluated in parallel against the same state, so adding
 * questions barely moves the response time. One request per turn, never one
 * request per question.
 *
 * Wire format ported from the client already running in production
 * (jevmail/jev.py).
 */

export interface JevOptions extends RetryOptions {
  apiKey: string;
  /** Defaults to OpenRouter's Decisions endpoint. */
  baseUrl?: string;
  model?: string;
  /**
   * Restrict routing to zero-data-retention providers. Per request, OR-ed with
   * whatever the account is configured for. On by default: this thing sees
   * customer conversations.
   */
  zdr?: boolean;
  maxRps?: number;
  appName?: string;
  /** Jev bills input only; output tokens are free. */
  inputPricePerMTok?: number;
  limiter?: RateLimiter;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export class JevProvider {
  readonly name = "jev";
  readonly usage: JevUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly model: string;
  private readonly zdr: boolean;
  private readonly limiter: RateLimiter;
  private readonly inputPricePerMTok: number;
  private readonly retry: RetryOptions;

  constructor(options: JevOptions) {
    this.url = options.baseUrl ?? "https://openrouter.ai/api/alpha/decisions";
    this.model = options.model ?? "typesafe/jev-1.13";
    this.zdr = options.zdr ?? true;
    this.limiter = options.limiter ?? new RateLimiter(options.maxRps ?? 15);
    this.inputPricePerMTok = options.inputPricePerMTok ?? 0.042;
    this.retry = options;
    this.headers = {
      authorization: `Bearer ${options.apiKey}`,
      "x-title": options.appName ?? "guarded-agent",
    };
  }

  /** One decision. Answers every question in a single request. */
  async decide(state: unknown, questions: QuestionMap): Promise<Answers> {
    await this.limiter.acquire();

    const raw = await postJson(this.url, this.headers, this.payload(state, questions), this.retry);
    const body = raw as { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };

    if (!body.answers || typeof body.answers !== "object") {
      throw new ProviderError(`Jev response had no "answers": ${JSON.stringify(raw).slice(0, 300)}`);
    }

    this.usage.inputTokens += body.usage?.input_tokens ?? 0;
    this.usage.outputTokens += body.usage?.output_tokens ?? 0;
    this.usage.requests += 1;

    return body.answers as Answers;
  }

  /** Estimated spend so far. Input only — Jev does not bill output tokens. */
  costUsd(): number {
    return (this.usage.inputTokens / 1_000_000) * this.inputPricePerMTok;
  }

  payload(state: unknown, questions: QuestionMap): Record<string, unknown> {
    return {
      model: this.model,
      state,
      // Question objects are already the wire format: JevClassifier is a
      // pass-through and LlmClassifier is the one that translates.
      questions,
      ...(this.zdr ? { zdr: true } : {}),
    };
  }
}
