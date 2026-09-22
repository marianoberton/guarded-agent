import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptyConversation, runTurn } from "../../src/core/turn.js";
import { defineTool } from "../../src/tools/defineTool.js";
import type { Inbound } from "../../src/core/types.js";
import { completion, deps, stubLlm, toolCall } from "../helpers.js";

const echo = defineTool({
  name: "echo",
  description: "Echoes back a value.",
  schema: z.object({ value: z.string() }),
  run: (args) => `echoed: ${args.value}`,
});

const failing = defineTool({
  name: "explode",
  description: "Always throws.",
  schema: z.object({}),
  run: () => {
    throw new Error("boom");
  },
});

const inbound: Inbound = { conversationId: "c1", text: "hello", at: 1_000 };

describe("runTurn", () => {
  it("produces a byte-identical trace across runs with the same stubs", async () => {
    // The test that matters more than the others: if this fails, ambient I/O is
    // leaking into runTurn and every other guarantee in the library is void.
    const run = async () =>
      runTurn(
        emptyConversation("c1"),
        inbound,
        deps({
          llm: stubLlm([
            completion({ toolCalls: [toolCall("echo", { value: "hi" })], stopReason: "tool_use" }),
            completion({ text: "Done." }),
          ]).fn,
          tools: [echo],
        }),
      );

    const first = await run();
    const second = await run();

    expect(JSON.stringify(second.trace)).toBe(JSON.stringify(first.trace));
    expect(JSON.stringify(second.actions)).toBe(JSON.stringify(first.actions));
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
  });

  it("answers a simple question without touching tools", async () => {
    const llm = stubLlm([completion({ text: "Hi there." })]);
    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({ llm: llm.fn, tools: [echo] }),
    );

    expect(result.actions).toEqual([{ type: "send", text: "Hi there." }]);
    expect(result.trace.map((e) => e.step)).toEqual(["respond", "send"]);
    expect(result.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hi there." });
    expect(result.state.lastCustomerMessageAt).toBe(1_000);
  });

  it("runs a tool and feeds its text back to the model", async () => {
    const llm = stubLlm([
      completion({ toolCalls: [toolCall("echo", { value: "hi" })], stopReason: "tool_use" }),
      completion({ text: "It said hi." }),
    ]);

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({ llm: llm.fn, tools: [echo] }),
    );

    expect(result.actions).toEqual([{ type: "send", text: "It said hi." }]);
    expect(llm.requests[1]?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: null, toolCalls: [toolCall("echo", { value: "hi" })] },
      { role: "tool", toolCallId: "call-echo", content: "echoed: hi" },
    ]);

    const toolEntry = result.trace.find((e) => e.step === "tool:echo");
    expect(toolEntry).toMatchObject({ by: "code", outcome: "ok" });
  });

  it("answers every parallel tool call, keeping the results adjacent", async () => {
    // Anthropic needs all tool_results for one turn inside a single user
    // message; dropping or splitting them breaks the API or stops the model
    // from issuing parallel calls at all.
    const llm = stubLlm([
      completion({
        toolCalls: [
          toolCall("echo", { value: "a" }, "call-1"),
          toolCall("echo", { value: "b" }, "call-2"),
          toolCall("nope", {}, "call-3"),
        ],
        stopReason: "tool_use",
      }),
      completion({ text: "All three handled." }),
    ]);

    await runTurn(emptyConversation("c1"), inbound, deps({ llm: llm.fn, tools: [echo] }));

    const followUp = llm.requests[1]?.messages ?? [];
    const results = followUp.filter((m) => m.role === "tool");
    expect(results).toHaveLength(3);
    expect(results.map((m) => (m.role === "tool" ? m.toolCallId : ""))).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
    // Adjacency: the tool results are the tail of the transcript, uninterrupted.
    expect(followUp.slice(-3).every((m) => m.role === "tool")).toBe(true);
  });

  it("hands invalid arguments back to the model instead of failing the turn", async () => {
    const llm = stubLlm([
      completion({ toolCalls: [toolCall("echo", { value: 42 })], stopReason: "tool_use" }),
      completion({ text: "Fixed it." }),
    ]);

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({ llm: llm.fn, tools: [echo] }),
    );

    const toolResult = llm.requests[1]?.messages.at(-1);
    expect(toolResult).toMatchObject({ role: "tool", isError: true });
    expect(toolResult && "content" in toolResult ? toolResult.content : "").toContain(
      "Invalid arguments",
    );
    expect(result.actions).toEqual([{ type: "send", text: "Fixed it." }]);
  });

  it("turns a throwing tool into an error result", async () => {
    const llm = stubLlm([
      completion({ toolCalls: [toolCall("explode", {})], stopReason: "tool_use" }),
      completion({ text: "That failed." }),
    ]);

    await runTurn(emptyConversation("c1"), inbound, deps({ llm: llm.fn, tools: [failing] }));

    const toolResult = llm.requests[1]?.messages.at(-1);
    expect(toolResult && "content" in toolResult ? toolResult.content : "").toContain("boom");
  });

  it("escalates to a human when the tool loop hits its cap", async () => {
    const llm = stubLlm(
      Array.from({ length: 3 }, () =>
        completion({ toolCalls: [toolCall("echo", { value: "again" })], stopReason: "tool_use" }),
      ),
    );

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: llm.fn,
        tools: [echo],
        config: {
          system: "s",
          model: "test/model",
          maxTokens: 256,
          maxToolIterations: 3,
        },
      }),
    );

    expect(result.state.status).toBe("handoff_requested");
    expect(result.actions).toEqual([
      { type: "setStatus", status: "handoff_requested", reason: "max_tool_iterations" },
    ]);
    expect(result.trace.at(-1)).toMatchObject({ outcome: "max_tool_iterations" });
  });

  it("sends nothing when the model returns an empty reply", async () => {
    const llm = stubLlm([completion({ text: "   " })]);
    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({ llm: llm.fn, tools: [echo] }),
    );

    expect(result.actions).toEqual([]);
    expect(result.trace.at(-1)).toMatchObject({ outcome: "skipped:empty_reply" });
  });
});
