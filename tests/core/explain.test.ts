import { describe, expect, it } from "vitest";
import { explain, explainTurn } from "../../src/core/explain.js";
import { MemoryStore } from "../../src/stores/memory.js";
import type { StoredTurn } from "../../src/stores/types.js";

const turn: StoredTurn = {
  id: "t-1",
  conversationId: "c-1",
  at: 1_000,
  inbound: "¿me lo dejás en 15?",
  actions: [{ type: "setStatus", status: "handoff_requested", reason: "price_negotiation" }],
  trace: [
    { step: "preCheck", by: "code", outcome: "ok", latencyMs: 0 },
    {
      step: "classify",
      by: "jev",
      outcome: "ok",
      latencyMs: 98,
      detail: {
        answers: {
          intent: { type: "choice", choice: "price_negotiation", confidence: 0.94 },
          needs_human: { type: "noul", noul: 0.12 },
          urgency: { type: "score", score: 1.8, confidence: 0.7 },
        },
      },
    },
    {
      step: "respond",
      by: "llm",
      outcome: "end",
      latencyMs: 812,
      usage: { inputTokens: 1240, outputTokens: 32 },
      costUsd: 0.000_412,
    },
  ],
};

describe("explain", () => {
  it("names who made each decision", () => {
    const output = explain(turn);
    expect(output).toContain("code  preCheck");
    expect(output).toContain("jev   classify");
    expect(output).toContain("llm   respond");
  });

  it("shows the probability next to every classifier answer", () => {
    // A decision recorded as "price_negotiation" without the 0.94 beside it
    // cannot be argued with after the fact.
    const output = explain(turn);
    expect(output).toContain("price_negotiation");
    expect(output).toContain("conf=0.94");
    expect(output).toContain("= 0.12");
    expect(output).toContain("= 1.80");
  });

  it("reports the actions the turn produced", () => {
    expect(explain(turn)).toContain("actions: setStatus:handoff_requested(price_negotiation)");
  });

  it("totals latency, tokens and cost", () => {
    const output = explain(turn);
    expect(output).toContain("total: 910ms");
    expect(output).toContain("1272 tokens");
    expect(output).toContain("$0.000412");
  });

  it("says so plainly when a turn produced no actions", () => {
    expect(explain({ ...turn, actions: [] })).toContain("actions: (none)");
  });

  it("omits the cost column when no provider reported one", () => {
    const free: StoredTurn = {
      ...turn,
      trace: [{ step: "preCheck", by: "code", outcome: "skipped:paused", latencyMs: 0 }],
    };
    expect(explain(free)).not.toContain("$");
  });
});

describe("explainTurn", () => {
  it("renders a turn from the store", async () => {
    const store = new MemoryStore();
    await store.recordTurn(turn);
    await expect(explainTurn(store, "t-1")).resolves.toContain("jev   classify");
  });

  it("returns null for a turn that was never recorded", async () => {
    await expect(explainTurn(new MemoryStore(), "nope")).resolves.toBeNull();
  });
});
