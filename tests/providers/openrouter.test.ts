import { describe, expect, it } from "vitest";
import {
  fromOpenRouterResponse,
  toOpenRouterPayload,
} from "../../src/providers/openrouter.js";
import { ProviderError } from "../../src/providers/types.js";
import type { CompletionRequest } from "../../src/providers/types.js";

const request: CompletionRequest = {
  model: "anthropic/claude-sonnet-4.6",
  system: "be brief",
  messages: [
    { role: "user", content: "find two things" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "t1", name: "lookup", args: { q: "corolla" } }],
    },
    { role: "tool", toolCallId: "t1", content: "one match" },
  ],
  tools: [
    {
      name: "lookup",
      description: "Look something up.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
  maxTokens: 512,
};

describe("toOpenRouterPayload", () => {
  it("prepends system as a message and serializes tool arguments", () => {
    const payload = toOpenRouterPayload(request) as {
      messages: Record<string, unknown>[];
      tools: Record<string, unknown>[];
      usage: unknown;
    };

    expect(payload.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(payload.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "lookup", arguments: '{"q":"corolla"}' } },
      ],
    });
    // OpenAI-shaped APIs take one message per tool result — no grouping here,
    // unlike Anthropic.
    expect(payload.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: "one match",
    });
    expect(payload.tools[0]).toMatchObject({ type: "function" });
    // Ask OpenRouter to report what the call cost, so the trace can carry it.
    expect(payload.usage).toEqual({ include: true });
  });

  it("omits tools entirely when there are none", () => {
    expect(toOpenRouterPayload({ ...request, tools: [] })).not.toHaveProperty("tools");
  });
});

describe("fromOpenRouterResponse", () => {
  it("parses tool call arguments instead of passing the raw string through", () => {
    const completion = fromOpenRouterResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "t1", function: { name: "lookup", arguments: '{"q":"corolla","year":2022}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 12, cost: 0.000345 },
    });

    expect(completion.toolCalls).toEqual([
      { id: "t1", name: "lookup", args: { q: "corolla", year: 2022 } },
    ]);
    expect(completion.stopReason).toBe("tool_use");
    expect(completion.usage).toEqual({ inputTokens: 100, outputTokens: 12 });
    expect(completion.costUsd).toBe(0.000345);
  });

  it("keeps unparseable arguments so the tool schema can reject them", () => {
    const completion = fromOpenRouterResponse({
      choices: [
        {
          message: { tool_calls: [{ id: "t1", function: { name: "f", arguments: "{not json" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });

    expect(completion.toolCalls[0]?.args).toEqual({ __unparsed: "{not json" });
  });

  it("maps finish reasons onto the neutral vocabulary", () => {
    const reason = (finish: string): string =>
      fromOpenRouterResponse({ choices: [{ message: { content: "x" }, finish_reason: finish }] })
        .stopReason;

    expect(reason("stop")).toBe("end");
    expect(reason("length")).toBe("max_tokens");
    expect(reason("content_filter")).toBe("refusal");
    expect(reason("something_new")).toBe("other");
  });

  it("throws when the response carries no choices", () => {
    expect(() => fromOpenRouterResponse({ choices: [] })).toThrow(ProviderError);
  });

  it("omits cost when OpenRouter did not report one", () => {
    const completion = fromOpenRouterResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });

    expect(completion.costUsd).toBeUndefined();
  });
});
