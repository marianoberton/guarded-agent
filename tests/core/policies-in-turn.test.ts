import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { emptyConversation, runTurn } from "../../src/core/turn.js";
import { defineTool } from "../../src/tools/defineTool.js";
import { escalateWhen, notContains, riskGate, veto } from "../../src/policies/index.js";
import { JevProvider } from "../../src/providers/jev.js";
import { JevClassifier } from "../../src/classify/JevClassifier.js";
import { noul, choice } from "../../src/jev/questions.js";
import type { Inbound } from "../../src/core/types.js";
import type { Policy } from "../../src/policies/types.js";
import { completion, deps, stubLlm, toolCall } from "../helpers.js";

/**
 * The four things M2 promises, exercised end to end through runTurn rather
 * than against the policy functions in isolation.
 */

const sendQuote = defineTool({
  name: "sendQuote",
  description: "Send a formal written quote for a car.",
  sideEffecting: true,
  schema: z.object({ carId: z.string(), discountPct: z.number().default(0) }),
  run: (args) => `Quote sent for ${args.carId} with ${args.discountPct}% off.`,
});

const deleteCustomer = defineTool({
  name: "deleteCustomer",
  description: "Permanently delete a customer record and all their history.",
  sideEffecting: true,
  schema: z.object({ customerId: z.string() }),
  run: (args) => `Deleted ${args.customerId}.`,
});

const lookupStock = defineTool({
  name: "lookupStock",
  description: "Search available cars.",
  schema: z.object({}),
  run: () => "A-1: Corolla 2022 automatic, USD 18,500.",
});

const inbound: Inbound = { conversationId: "c1", text: "¿me lo dejás en 15?", at: 1_000 };

function stubJev(answers: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M2: a discount over 10% is blocked", () => {
  it("refuses the call, tells the model why, and lets the turn continue", async () => {
    const llm = stubLlm([
      completion({
        toolCalls: [toolCall("sendQuote", { carId: "A-1", discountPct: 15 })],
        stopReason: "tool_use",
      }),
      completion({ text: "No puedo ofrecer ese descuento, pero lo consulto con un asesor." }),
    ]);

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: llm.fn,
        tools: [sendQuote],
        policies: [
          veto({
            tool: sendQuote,
            when: (c) => c.args.discountPct > 10,
            reason: "discount_over_10",
          }),
        ],
      }),
    );

    const toolResult = llm.requests[1]?.messages.at(-1);
    expect(toolResult).toMatchObject({ role: "tool", isError: true });
    expect(toolResult && "content" in toolResult ? toolResult.content : "").toContain(
      "discount_over_10",
    );

    // Blocked, not escalated: the agent stays in charge and takes another route.
    expect(result.state.status).toBe("agent");
    expect(result.actions).toEqual([
      { type: "send", text: "No puedo ofrecer ese descuento, pero lo consulto con un asesor." },
    ]);
    expect(
      result.trace.some((e) => e.step === "policy:veto(sendQuote)" && e.outcome === "block"),
    ).toBe(true);
  });

  it("lets a discount inside the limit through", async () => {
    const llm = stubLlm([
      completion({
        toolCalls: [toolCall("sendQuote", { carId: "A-1", discountPct: 5 })],
        stopReason: "tool_use",
      }),
      completion({ text: "Te mandé la cotización." }),
    ]);

    await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: llm.fn,
        tools: [sendQuote],
        policies: [veto({ tool: sendQuote, when: (c) => c.args.discountPct > 10 })],
      }),
    );

    const toolResult = llm.requests[1]?.messages.at(-1);
    expect(toolResult && "content" in toolResult ? toolResult.content : "").toContain("5% off");
  });
});

describe('M2: "quiero hablar con una persona" reaches handoff_requested', () => {
  it("escalates before a single responder token is spent", async () => {
    stubJev({ intent: { type: "choice", choice: "asks_for_human", confidence: 0.97 } });

    const llm = stubLlm([]); // must never be called
    const result = await runTurn(
      emptyConversation("c1"),
      { ...inbound, text: "quiero hablar con una persona" },
      deps({
        llm: llm.fn,
        tools: [lookupStock],
        classifier: new JevClassifier({
          jev: new JevProvider({ apiKey: "k", maxRps: 0 }),
          questions: {
            intent: choice("What does the customer want?", {
              asks_for_human: "Explicitly wants a person.",
              other: null,
            }),
          },
        }),
        policies: [escalateWhen({ intent: "asks_for_human" })],
      }),
    );

    expect(result.state.status).toBe("handoff_requested");
    expect(result.actions).toEqual([
      { type: "setStatus", status: "handoff_requested", reason: "intent=asks_for_human" },
    ]);
    // The whole point of deciding at the fork: no responder call happened.
    expect(llm.requests).toHaveLength(0);
    expect(result.trace.map((e) => e.step)).not.toContain("respond");
  });
});

describe("M2: riskGate blocks a fake deleteCustomer", () => {
  it("refuses the call when Jev says the business would not want it automated", async () => {
    stubJev({ risk: { type: "noul", noul: 0.95 } });

    const llm = stubLlm([
      completion({
        toolCalls: [toolCall("deleteCustomer", { customerId: "cust-9" })],
        stopReason: "tool_use",
      }),
      completion({ text: "No puedo hacer eso." }),
    ]);

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: llm.fn,
        tools: [deleteCustomer],
        policies: [
          riskGate({
            jev: new JevProvider({ apiKey: "k", maxRps: 0 }),
            question: noul("Is this something the business would not want done automatically?"),
            blockAbove: 0.8,
            escalateAbove: 0.5,
          }),
        ],
      }),
    );

    const toolResult = llm.requests[1]?.messages.at(-1);
    expect(toolResult).toMatchObject({ isError: true });
    expect(result.trace.some((e) => e.step === "policy:riskGate" && e.outcome === "block")).toBe(
      true,
    );
    // The record never got deleted.
    expect(result.trace.some((e) => e.step === "tool:deleteCustomer" && e.outcome === "ok")).toBe(
      false,
    );
  });

  it("hands over when the risk lands between the thresholds", async () => {
    stubJev({ risk: { type: "noul", noul: 0.66 } });

    const llm = stubLlm([
      completion({
        toolCalls: [toolCall("deleteCustomer", { customerId: "cust-9" })],
        stopReason: "tool_use",
      }),
    ]);

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: llm.fn,
        tools: [deleteCustomer],
        policies: [
          riskGate({
            jev: new JevProvider({ apiKey: "k", maxRps: 0 }),
            question: noul("Risky?"),
            blockAbove: 0.8,
            escalateAbove: 0.5,
          }),
        ],
      }),
    );

    expect(result.state.status).toBe("handoff_requested");
    // Escalation ends the turn: the model is not asked to carry on without us.
    expect(llm.requests).toHaveLength(1);
  });
});

describe("escalation inside a batch of parallel calls", () => {
  it("still answers every call, but runs none of the ones after it", async () => {
    stubJev({ risk: { type: "noul", noul: 0.66 } });

    const llm = stubLlm([
      completion({
        toolCalls: [
          toolCall("deleteCustomer", { customerId: "cust-9" }, "call-1"),
          toolCall("sendQuote", { carId: "A-1", discountPct: 0 }, "call-2"),
        ],
        stopReason: "tool_use",
      }),
    ]);

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: llm.fn,
        tools: [deleteCustomer, sendQuote],
        policies: [
          riskGate({
            jev: new JevProvider({ apiKey: "k", maxRps: 0 }),
            question: noul("Risky?"),
            blockAbove: 0.9,
            escalateAbove: 0.5,
          }),
        ],
      }),
    );

    expect(result.state.status).toBe("handoff_requested");
    // The second call was never executed — acting after handing over is acting
    // when you are no longer the one in charge.
    expect(result.trace.some((e) => e.step === "tool:sendQuote" && e.outcome === "ok")).toBe(false);
    expect(
      result.trace.some(
        (e) => e.step === "tool:sendQuote" && e.outcome === "not_executed:escalated",
      ),
    ).toBe(true);
  });
});

describe("policies.after()", () => {
  it("refuses to send a message that promises a discount", async () => {
    const llm = stubLlm([completion({ text: "Te hago un descuento del 20%." })]);

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: llm.fn,
        tools: [],
        policies: [notContains(["descuento", "discount"])],
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.state.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("substitutes a rewritten message and sends that instead", async () => {
    const rewriter: Policy = {
      name: "sanitize",
      after: () => ({ type: "rewrite", reason: "sanitized", text: "Consulto y te confirmo." }),
    };

    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({
        llm: stubLlm([completion({ text: "Te hago un descuento del 20%." })]).fn,
        tools: [],
        policies: [rewriter],
      }),
    );

    expect(result.actions).toEqual([{ type: "send", text: "Consulto y te confirmo." }]);
    expect(result.state.messages.at(-1)?.text).toBe("Consulto y te confirmo.");
  });
});

describe("turnsWithoutProgress", () => {
  it("counts up on a turn where no tool ran", async () => {
    const result = await runTurn(
      emptyConversation("c1"),
      inbound,
      deps({ llm: stubLlm([completion({ text: "Claro." })]).fn, tools: [lookupStock] }),
    );
    expect(result.state.turnsWithoutProgress).toBe(1);
  });

  it("resets as soon as the agent actually does something", async () => {
    const result = await runTurn(
      { ...emptyConversation("c1"), turnsWithoutProgress: 3 },
      inbound,
      deps({
        llm: stubLlm([
          completion({ toolCalls: [toolCall("lookupStock", {})], stopReason: "tool_use" }),
          completion({ text: "Tenemos uno." }),
        ]).fn,
        tools: [lookupStock],
      }),
    );
    expect(result.state.turnsWithoutProgress).toBe(0);
  });

  it("does not count a blocked call as progress", async () => {
    const result = await runTurn(
      { ...emptyConversation("c1"), turnsWithoutProgress: 1 },
      inbound,
      deps({
        llm: stubLlm([
          completion({
            toolCalls: [toolCall("sendQuote", { carId: "A-1", discountPct: 99 })],
            stopReason: "tool_use",
          }),
          completion({ text: "No puedo." }),
        ]).fn,
        tools: [sendQuote],
        policies: [veto({ tool: sendQuote, when: (c) => c.args.discountPct > 10 })],
      }),
    );
    expect(result.state.turnsWithoutProgress).toBe(2);
  });
});
