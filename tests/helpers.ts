import type { Completion, CompletionRequest, ToolCall } from "../src/providers/types.js";
import type { TurnDeps } from "../src/core/types.js";
import type { Tool } from "../src/tools/defineTool.js";

/** A clock that advances one tick per read. Deterministic, and never the wall clock. */
export function fakeClock(start = 0): () => number {
  let t = start;
  return () => ++t;
}

/** Ids that are stable across runs, so traces compare byte for byte. */
export function fakeIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

export function completion(partial: Partial<Completion> = {}): Completion {
  return {
    text: null,
    toolCalls: [],
    stopReason: "end",
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: {},
    ...partial,
  };
}

export function toolCall(name: string, args: unknown, id = `call-${name}`): ToolCall {
  return { id, name, args };
}

export interface StubLlm {
  fn: TurnDeps["llm"];
  requests: CompletionRequest[];
}

/** Replays canned completions in order and records what it was asked. */
export function stubLlm(responses: Completion[]): StubLlm {
  const requests: CompletionRequest[] = [];
  let index = 0;
  return {
    requests,
    fn: async (req) => {
      requests.push(structuredClone(req));
      const response = responses[index++];
      if (!response) throw new Error(`stubLlm ran out of responses at call ${index}`);
      return response;
    },
  };
}

export function deps(
  overrides: Partial<TurnDeps> & { llm: TurnDeps["llm"]; tools: readonly Tool[] },
): TurnDeps {
  return {
    now: fakeClock(),
    newId: fakeIds(),
    config: {
      system: "You are a test assistant.",
      model: "test/model",
      maxTokens: 256,
      maxToolIterations: 5,
    },
    ...overrides,
  };
}
