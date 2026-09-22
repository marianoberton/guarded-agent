/**
 * The provider boundary.
 *
 * A Provider does exactly one thing: turn a CompletionRequest into a Completion.
 * It does NOT own the tool loop. The loop lives in core/turn.ts, because every
 * tool call has to pass through the policy layer before it runs, and because the
 * same loop has to work against Anthropic's Messages API and OpenAI-shaped
 * chat/completions alike.
 */

/** A tool as the model sees it. Produced from a zod schema by defineTool. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12), object type, additionalProperties: false. */
  inputSchema: Record<string, unknown>;
  /**
   * Ask the provider to guarantee schema-valid arguments. Opt-in: strict mode
   * requires every property to be required, so tools with optional inputs
   * cannot use it. Arguments are validated with zod on receipt either way,
   * which is the real safety net.
   */
  strict?: boolean;
}

export interface ToolCall {
  /** Provider-assigned id. Every call must be answered with a matching result. */
  id: string;
  name: string;
  /** Already JSON.parse'd. Never string-match a serialized tool input. */
  args: unknown;
}

/**
 * Provider-neutral transcript entry.
 *
 * Consecutive `tool` entries represent results for tool calls issued in the same
 * assistant turn. Providers that need them batched (Anthropic wants every
 * tool_result for a turn inside one user message) group them when translating.
 */
export type ProviderMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export interface CompletionRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Completion {
  text: string | null;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  costUsd?: number;
  /** Untouched provider payload, for the trace. */
  raw: unknown;
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<Completion>;
}

/** Raised for non-recoverable provider failures. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
