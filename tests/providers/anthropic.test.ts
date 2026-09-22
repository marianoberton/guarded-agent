import { describe, expect, it } from "vitest";
import {
  fromAnthropicResponse,
  toAnthropicMessages,
  toAnthropicPayload,
} from "../../src/providers/anthropic.js";
import type { CompletionRequest, ProviderMessage } from "../../src/providers/types.js";

/**
 * AnthropicProvider has never run against the live API — this project has no
 * Anthropic key. These tests cover the translation in both directions, which is
 * where format-specific bugs actually live.
 */
describe("toAnthropicMessages", () => {
  it("packs every tool result for one turn into a single user message", () => {
    // The rule that makes this function necessary: Anthropic rejects a turn
    // whose tool_results are spread across several user messages, and splitting
    // them trains the model out of issuing parallel calls.
    const messages: ProviderMessage[] = [
      { role: "user", content: "find two things" },
      {
        role: "assistant",
        content: "Looking.",
        toolCalls: [
          { id: "t1", name: "lookup", args: { q: "a" } },
          { id: "t2", name: "lookup", args: { q: "b" } },
        ],
      },
      { role: "tool", toolCallId: "t1", content: "first" },
      { role: "tool", toolCallId: "t2", content: "second", isError: true },
    ];

    const out = toAnthropicMessages(messages);

    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "first" },
        { type: "tool_result", tool_use_id: "t2", content: "second", is_error: true },
      ],
    });
  });

  it("emits text and tool_use blocks for an assistant turn", () => {
    const out = toAnthropicMessages([
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [{ id: "t1", name: "f", args: { x: 1 } }],
      },
    ]);

    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "f", input: { x: 1 } },
      ],
    });
  });

  it("omits the text block when the assistant only called tools", () => {
    const out = toAnthropicMessages([
      { role: "assistant", content: null, toolCalls: [{ id: "t1", name: "f", args: {} }] },
    ]);

    expect(out[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
    });
  });

  it("starts a new user message after tool results are flushed", () => {
    const out = toAnthropicMessages([
      { role: "tool", toolCallId: "t1", content: "r" },
      { role: "user", content: "and now this" },
    ]);

    expect(out).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
      { role: "user", content: [{ type: "text", text: "and now this" }] },
    ]);
  });
});

describe("toAnthropicPayload", () => {
  const request: CompletionRequest = {
    model: "claude-sonnet-4-6",
    system: "be brief",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "lookup",
        description: "Look something up.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        strict: true,
      },
    ],
    maxTokens: 512,
  };

  it("puts system at the top level and uses input_schema for tools", () => {
    expect(toAnthropicPayload(request)).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: "be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          name: "lookup",
          description: "Look something up.",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
          strict: true,
        },
      ],
    });
  });

  it("omits tools entirely when there are none", () => {
    const payload = toAnthropicPayload({ ...request, tools: [] });
    expect(payload).not.toHaveProperty("tools");
  });
});

describe("fromAnthropicResponse", () => {
  it("splits content blocks into text and tool calls", () => {
    const completion = fromAnthropicResponse({
      content: [
        { type: "text", text: "One moment. " },
        { type: "tool_use", id: "t1", name: "lookup", input: { q: "corolla" } },
        { type: "text", text: "Checking." },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 8 },
    });

    expect(completion.text).toBe("One moment. Checking.");
    expect(completion.toolCalls).toEqual([{ id: "t1", name: "lookup", args: { q: "corolla" } }]);
    expect(completion.stopReason).toBe("tool_use");
    expect(completion.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
  });

  it("maps stop reasons onto the neutral vocabulary", () => {
    const reason = (stop: string): string =>
      fromAnthropicResponse({ content: [], stop_reason: stop }).stopReason;

    expect(reason("end_turn")).toBe("end");
    expect(reason("stop_sequence")).toBe("end");
    expect(reason("max_tokens")).toBe("max_tokens");
    expect(reason("refusal")).toBe("refusal");
    expect(reason("pause_turn")).toBe("other");
  });

  it("reports null text when the model only called tools", () => {
    const completion = fromAnthropicResponse({
      content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
      stop_reason: "tool_use",
    });

    expect(completion.text).toBeNull();
  });
});
