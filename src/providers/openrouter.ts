import { postJson, type RetryOptions } from "./http.js";
import {
  ProviderError,
  type Completion,
  type CompletionRequest,
  type Provider,
  type ProviderMessage,
  type StopReason,
  type ToolCall,
} from "./types.js";

export interface OpenRouterOptions extends RetryOptions {
  apiKey: string;
  baseUrl?: string;
  /** Sent as X-Title; shows up in the OpenRouter dashboard. */
  appName?: string;
}

/**
 * OpenAI-shaped chat/completions, which is what OpenRouter speaks.
 * Translation only — the tool loop lives in core/turn.ts.
 */
export class OpenRouterProvider implements Provider {
  readonly name = "openrouter";

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly retry: RetryOptions;

  constructor(options: OpenRouterOptions) {
    const base = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.url = `${base}/chat/completions`;
    this.headers = {
      authorization: `Bearer ${options.apiKey}`,
      "x-title": options.appName ?? "guarded-agent",
    };
    this.retry = options;
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const payload = toOpenRouterPayload(req);
    const raw = await postJson(this.url, this.headers, payload, this.retry);
    return fromOpenRouterResponse(raw);
  }
}

export function toOpenRouterPayload(req: CompletionRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];

  for (const message of req.messages) {
    messages.push(toOpenRouterMessage(message));
  }

  const payload: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages,
    // Asks OpenRouter to report what the call actually cost.
    usage: { include: true },
  };

  if (req.tools.length > 0) {
    payload["tools"] = req.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        ...(tool.strict ? { strict: true } : {}),
      },
    }));
  }

  return payload;
}

function toOpenRouterMessage(message: ProviderMessage): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
              })),
            }
          : {}),
      };
    case "tool":
      // OpenAI-shaped APIs take one message per result; no grouping needed.
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

export function fromOpenRouterResponse(raw: unknown): Completion {
  const body = raw as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };

  const choice = body.choices?.[0];
  if (!choice) throw new ProviderError("OpenRouter response had no choices");

  const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? "",
    // Always parse. Never string-match a serialized tool input.
    args: parseArgs(call.function?.arguments),
  }));

  const completion: Completion = {
    text: choice.message?.content ?? null,
    toolCalls,
    stopReason: toStopReason(choice.finish_reason, toolCalls.length > 0),
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
    raw,
  };

  if (typeof body.usage?.cost === "number") completion.costUsd = body.usage.cost;
  return completion;
}

function parseArgs(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Let the tool's zod schema reject it and tell the model what was wrong.
    return { __unparsed: text };
  }
}

function toStopReason(finishReason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  switch (finishReason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}
