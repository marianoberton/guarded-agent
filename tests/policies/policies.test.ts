import { afterEach, describe, expect, it, vi } from "vitest";
import {
  escalateWhen,
  evaluate,
  maxTurnsWithoutProgress,
  notContains,
  requireApproval,
  riskGate,
  veto,
} from "../../src/policies/index.js";
import { JevProvider } from "../../src/providers/jev.js";
import { emptyConversation } from "../../src/core/turn.js";
import { defineTool } from "../../src/tools/defineTool.js";
import { noul } from "../../src/jev/questions.js";
import { z } from "zod";
import type { ActionContext, BeforeContext, Policy } from "../../src/policies/types.js";
import type { Answers } from "../../src/classify/types.js";

const inbound = { conversationId: "c1", text: "¿me lo dejás en 15?", at: 1_000 };

const sendQuote = defineTool({
  name: "sendQuote",
  description: "Send a formal written quote.",
  sideEffecting: true,
  schema: z.object({ carId: z.string(), discountPct: z.number() }),
  run: () => "sent",
});

const lookupStock = defineTool({
  name: "lookupStock",
  description: "Search available cars.",
  schema: z.object({}),
  run: () => "found",
});

function beforeCtx(answers: Answers, overrides: Partial<BeforeContext> = {}): BeforeContext {
  return { state: emptyConversation("c1"), inbound, answers, now: 1_000, ...overrides };
}

function actionCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    state: emptyConversation("c1"),
    inbound,
    answers: {},
    now: 1_000,
    tool: sendQuote,
    call: { id: "t1", name: "sendQuote", args: { carId: "A-1", discountPct: 5 } },
    args: { carId: "A-1", discountPct: 5 },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("escalateWhen", () => {
  it("escalates on a matching choice", async () => {
    const policy = escalateWhen({ intent: "price_negotiation" });
    const answers: Answers = {
      intent: { type: "choice", choice: "price_negotiation", confidence: 0.94 },
    };

    expect(await policy.before?.(beforeCtx(answers))).toMatchObject({
      type: "escalate",
      reason: "intent=price_negotiation",
    });
  });

  it("allows a different choice through", async () => {
    const policy = escalateWhen({ intent: "price_negotiation" });
    const answers: Answers = { intent: { type: "choice", choice: "stock_question" } };
    expect(await policy.before?.(beforeCtx(answers))).toEqual({ type: "allow" });
  });

  it("escalates on a noul above the threshold, and not at it", async () => {
    const policy = escalateWhen({ noul: "needs_human", above: 0.85 });

    expect(
      await policy.before?.(beforeCtx({ needs_human: { type: "noul", noul: 0.9 } })),
    ).toMatchObject({ type: "escalate" });
    // Strictly above: a threshold you can hit exactly should not fire.
    expect(await policy.before?.(beforeCtx({ needs_human: { type: "noul", noul: 0.85 } }))).toEqual(
      { type: "allow" },
    );
  });

  it("records the probability in the reason so the decision can be audited", async () => {
    const policy = escalateWhen({ noul: "needs_human", above: 0.5 });
    const verdict = await policy.before?.(beforeCtx({ needs_human: { type: "noul", noul: 0.73 } }));
    expect(verdict).toMatchObject({ reason: "needs_human=0.73>0.5" });
  });
});

describe("veto", () => {
  it("blocks a call whose arguments break the rule", async () => {
    const policy = veto({
      tool: sendQuote,
      when: (c) => c.args.discountPct > 10,
      reason: "discount_over_10",
    });

    const verdict = await policy.onAction?.(actionCtx({ args: { carId: "A-1", discountPct: 15 } }));
    expect(verdict).toMatchObject({ type: "block", reason: "discount_over_10" });
  });

  it("allows the same tool when the rule does not fire", async () => {
    const policy = veto({ tool: sendQuote, when: (c) => c.args.discountPct > 10 });
    expect(await policy.onAction?.(actionCtx())).toEqual({ type: "allow" });
  });

  it("ignores calls to other tools entirely", async () => {
    const policy = veto({
      tool: sendQuote,
      when: () => {
        throw new Error("must not be consulted for another tool");
      },
    });

    const verdict = await policy.onAction?.(
      actionCtx({ tool: lookupStock, call: { id: "t1", name: "lookupStock", args: {} } }),
    );
    expect(verdict).toEqual({ type: "allow" });
  });

  it("tells the model not to retry, so it takes a different route", async () => {
    const policy = veto({ tool: sendQuote, when: () => true });
    const verdict = await policy.onAction?.(actionCtx());
    expect(verdict && "toolResultText" in verdict ? verdict.toolResultText : "").toContain(
      "Do not retry",
    );
  });
});

describe("requireApproval", () => {
  it("escalates before a named tool runs", async () => {
    const policy = requireApproval({ tools: ["sendQuote"] });
    expect(await policy.onAction?.(actionCtx())).toMatchObject({
      type: "escalate",
      reason: "approval_required:sendQuote",
    });
  });

  it("leaves unnamed tools alone", async () => {
    const policy = requireApproval({ tools: ["deleteCustomer"] });
    expect(await policy.onAction?.(actionCtx())).toEqual({ type: "allow" });
  });
});

describe("riskGate", () => {
  function stubRisk(value: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ answers: { risk: { type: "noul", noul: value } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function gate(): Policy {
    return riskGate({
      jev: new JevProvider({ apiKey: "k", maxRps: 0 }),
      question: noul("Is this action something the business would not want done automatically?"),
      blockAbove: 0.8,
      escalateAbove: 0.5,
    });
  }

  it("blocks a high-risk action", async () => {
    stubRisk(0.93);
    expect(await gate().onAction?.(actionCtx())).toMatchObject({
      type: "block",
      reason: "risk=0.93>0.8",
    });
  });

  it("escalates a middling one", async () => {
    stubRisk(0.62);
    expect(await gate().onAction?.(actionCtx())).toMatchObject({
      type: "escalate",
      reason: "risk=0.62>0.5",
    });
  });

  it("allows a low-risk one", async () => {
    stubRisk(0.04);
    expect(await gate().onAction?.(actionCtx())).toEqual({ type: "allow" });
  });

  it("never asks about a read-only tool", async () => {
    // Asking whether reading a stock list is risky costs a request and answers
    // itself.
    const fetchMock = stubRisk(0.99);
    const verdict = await gate().onAction?.(
      actionCtx({ tool: lookupStock, call: { id: "t1", name: "lookupStock", args: {} } }),
    );

    expect(verdict).toEqual({ type: "allow" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the proposed arguments as the state Jev judges", async () => {
    const fetchMock = stubRisk(0.1);
    await gate().onAction?.(actionCtx({ args: { carId: "A-1", discountPct: 40 } }));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as {
      state: { action: string; arguments: { discountPct: number } };
    };
    expect(body.state.action).toBe("sendQuote");
    expect(body.state.arguments.discountPct).toBe(40);
  });
});

describe("maxTurnsWithoutProgress", () => {
  it("escalates once the counter reaches the limit", async () => {
    const policy = maxTurnsWithoutProgress(4);
    const state = { ...emptyConversation("c1"), turnsWithoutProgress: 4 };
    expect(await policy.before?.(beforeCtx({}, { state }))).toMatchObject({ type: "escalate" });
  });

  it("allows while the agent is still getting somewhere", async () => {
    const policy = maxTurnsWithoutProgress(4);
    const state = { ...emptyConversation("c1"), turnsWithoutProgress: 3 };
    expect(await policy.before?.(beforeCtx({}, { state }))).toEqual({ type: "allow" });
  });
});

describe("notContains", () => {
  it("refuses to send a promise the business cannot keep", async () => {
    const policy = notContains(["descuento", "discount"]);
    const ctx = { ...beforeCtx({}), text: "Te hago un descuento del 20%." };
    expect(await policy.after?.(ctx)).toMatchObject({
      type: "block",
      reason: "forbidden_term:descuento",
    });
  });

  it("is case insensitive", async () => {
    const policy = notContains(["descuento"]);
    const ctx = { ...beforeCtx({}), text: "DESCUENTO especial" };
    expect(await policy.after?.(ctx)).toMatchObject({ type: "block" });
  });

  it("lets a clean message through", async () => {
    const policy = notContains(["descuento"]);
    const ctx = { ...beforeCtx({}), text: "El precio es USD 18.500." };
    expect(await policy.after?.(ctx)).toEqual({ type: "allow" });
  });
});

describe("evaluate", () => {
  it("returns the first non-allow verdict and stops", async () => {
    let reached = false;
    const policies: Policy[] = [
      { name: "first", before: () => ({ type: "escalate", reason: "stop here" }) },
      {
        name: "second",
        before: () => {
          reached = true;
          return { type: "allow" };
        },
      },
    ];

    const result = await evaluate(policies, "before", beforeCtx({}));
    expect(result.verdict).toMatchObject({ reason: "stop here" });
    expect(result.policy?.name).toBe("first");
    expect(reached).toBe(false);
  });

  it("skips policies that do not implement the hook", async () => {
    const policies: Policy[] = [
      { name: "only-after", after: () => ({ type: "block", reason: "nope" }) },
    ];
    expect((await evaluate(policies, "before", beforeCtx({}))).verdict).toEqual({ type: "allow" });
  });

  it("allows when there are no policies at all", async () => {
    expect((await evaluate([], "before", beforeCtx({}))).verdict).toEqual({ type: "allow" });
  });
});
