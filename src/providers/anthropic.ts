import { postJson, type RetryOptions } from "./http.js";
import {
  type Completion,
  type CompletionRequest,
  type Provider,
  type ProviderMessage,
  type StopReason,
  type ToolCall,
} from "./types.js";

export interface AnthropicOptions extends RetryOptions {
  apiKey: string;
  baseUrl?: string;
  anthropicVersion?: string;
}

/**
 * Anthropic Messages API.
 *
 * NOT verified against the live API — this project runs on OpenRouter and has no
 * Anthropic key. What is verified is the translation in both directions
 * (tests/providers/anthropic.test.ts), which is where the format-specific bugs
 * live. Treat the network path as untested until someone runs it with a key.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly retry: RetryOptions;

  constructor(options: AnthropicOptions) {
    const base = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.url = `${base}/v1/messages`;
    this.headers = {
      "x-api-key": options.apiKey,
      "anthropic-version": options.anthropicVersion ?? "2023-06-01",
    };
    this.retry = options;
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const raw = await postJson(this.url, this.headers, toAnthropicPayload(req), this.retry);
    return fromAnthropicResponse(raw);
  }
}

export function toAnthropicPayload(req: CompletionRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: toAnthropicMessages(req.messages),
  };

  if (req.tools.length > 0) {
    payload["tools"] = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(tool.strict ? { strict: true } : {}),
    }));
  }

  return payload;
}

/**
 * Translates the neutral transcript, grouping consecutive tool results.
 *
 * This grouping is the whole reason this function exists. Anthropic requires
 * every tool_result for one assistant turn to arrive inside a SINGLE user
 * message. Emitting one message per result is an API error, and splitting them
 * teaches the model to stop issuing calls in parallel.
 */
export function toAnthropicMessages(messages: readonly ProviderMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let pendingResults: Record<string, unknown>[] = [];

  const flush = (): void => {
    if (pendingResults.length === 0) return;
    out.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }

    flush();

    if (message.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: message.content }] });
      continue;
    }

    const content: Record<string, unknown>[] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
    }
    out.push({ role: "assistant", content });
  }

  flush();
  return out;
}

export function fromAnthropicResponse(raw: unknown): Completion {
  const body = raw as {
    content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of body.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id ?? "", name: block.name ?? "", args: block.input ?? {} });
    }
  }

  return {
    text: texts.length > 0 ? texts.join("") : null,
    toolCalls,
    stopReason: toStopReason(body.stop_reason),
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    },
    raw,
  };
}

function toStopReason(stopReason: string | undefined): StopReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}
