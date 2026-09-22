import { describe, expect, it } from "vitest";
import { WebChannel, WhatsAppChannel, hoursToMs, windowState } from "../../src/channels/index.js";
import { emptyConversation, runTurn } from "../../src/core/turn.js";
import type { ConversationState, Inbound } from "../../src/core/types.js";
import { completion, deps, stubLlm } from "../helpers.js";

const HOUR = 60 * 60 * 1000;
const OPENED_AT = 1_000_000;

function conversation(lastCustomerMessageAt: number | null): ConversationState {
  return { ...emptyConversation("c1"), lastCustomerMessageAt };
}

describe("windowState", () => {
  it("is open right after the customer writes", () => {
    expect(windowState(OPENED_AT, OPENED_AT + 60_000, hoursToMs(24))).toMatchObject({
      open: true,
      closesAt: OPENED_AT + 24 * HOUR,
    });
  });

  it("is still open one minute before it shuts", () => {
    const state = windowState(OPENED_AT, OPENED_AT + 24 * HOUR - 60_000, hoursToMs(24));
    expect(state.open).toBe(true);
    expect(state.remainingMs).toBe(60_000);
  });

  it("is shut exactly on the boundary", () => {
    // A prompt told about a deadline fails silently at 24 hours and one minute.
    // This is why the rule lives in the runtime.
    const state = windowState(OPENED_AT, OPENED_AT + 24 * HOUR, hoursToMs(24));
    expect(state.open).toBe(false);
    expect(state.remainingMs).toBe(0);
  });

  it("never opens for a customer who has not written", () => {
    // A business cannot start a free-form WhatsApp conversation.
    expect(windowState(null, OPENED_AT)).toEqual({
      open: false,
      closesAt: null,
      remainingMs: 0,
    });
  });

  it("honours a non-default window length", () => {
    expect(windowState(OPENED_AT, OPENED_AT + 2 * HOUR, hoursToMs(1)).open).toBe(false);
    expect(windowState(OPENED_AT, OPENED_AT + 2 * HOUR, hoursToMs(3)).open).toBe(true);
  });
});

describe("WhatsAppChannel.plan", () => {
  const withTemplate = new WhatsAppChannel({ templates: { reopen: "hello_again" } });
  const withoutTemplate = new WhatsAppChannel();

  it("sends free-form inside the window", () => {
    expect(
      withTemplate.plan({
        state: conversation(OPENED_AT),
        text: "Tenemos uno.",
        now: OPENED_AT + HOUR,
      }),
    ).toEqual({ type: "free_form", text: "Tenemos uno." });
  });

  it("falls back to the reopen template outside the window", () => {
    const plan = withTemplate.plan({
      state: conversation(OPENED_AT),
      text: "Tenemos uno.",
      now: OPENED_AT + 25 * HOUR,
    });

    expect(plan).toMatchObject({ type: "template", template: "hello_again" });
    // The written reply travels with the template rather than vanishing.
    expect(plan.type === "template" ? plan.pendingText : "").toBe("Tenemos uno.");
  });

  it("defers when the window is shut and no template was configured", () => {
    const plan = withoutTemplate.plan({
      state: conversation(OPENED_AT),
      text: "Tenemos uno.",
      now: OPENED_AT + 25 * HOUR,
    });

    expect(plan).toMatchObject({ type: "deferred" });
    expect(plan.type === "deferred" ? plan.pendingText : "").toBe("Tenemos uno.");
  });

  it("distinguishes a window that shut from one that never opened", () => {
    const shut = withoutTemplate.plan({
      state: conversation(OPENED_AT),
      text: "x",
      now: OPENED_AT + 25 * HOUR,
    });
    const never = withoutTemplate.plan({ state: conversation(null), text: "x", now: OPENED_AT });

    expect(shut.type === "deferred" ? shut.reason : "").toContain("window_closed_at");
    expect(never.type === "deferred" ? never.reason : "").toBe("window_never_opened");
  });
});

describe("WebChannel", () => {
  it("has no window at all", () => {
    // If the only channel were WhatsApp, the window would have quietly become
    // part of the core instead of a property of one transport.
    expect(
      new WebChannel().plan({
        state: conversation(null),
        text: "hola",
        now: OPENED_AT + 1000 * HOUR,
      }),
    ).toEqual({ type: "free_form", text: "hola" });
  });
});

describe("the window inside a turn", () => {
  function turnAt(
    now: number,
    channel: WhatsAppChannel,
    state: ConversationState,
  ): ReturnType<typeof runTurn> {
    const inbound: Inbound = { conversationId: "c1", text: "¿siguen abiertos?", at: now };
    let tick = now;
    return runTurn(state, inbound, {
      ...deps({ llm: stubLlm([completion({ text: "Sí, hasta las 18." })]).fn, tools: [] }),
      channel,
      now: () => tick++,
    });
  }

  it("sends normally while the window is open", async () => {
    const result = await turnAt(
      OPENED_AT,
      new WhatsAppChannel({ templates: { reopen: "hello_again" } }),
      conversation(OPENED_AT),
    );

    expect(result.actions).toEqual([{ type: "send", text: "Sí, hasta las 18." }]);
  });

  it("moves to awaiting_reopen and emits the template when it is shut", async () => {
    // The inbound is old: it arrived, but the agent is only answering now.
    const state = conversation(OPENED_AT);
    const inbound: Inbound = { conversationId: "c1", text: "hola", at: OPENED_AT };
    let tick = OPENED_AT + 30 * HOUR;

    const result = await runTurn({ ...state, lastCustomerMessageAt: OPENED_AT }, inbound, {
      ...deps({ llm: stubLlm([completion({ text: "Sí, hasta las 18." })]).fn, tools: [] }),
      channel: new WhatsAppChannel({ templates: { reopen: "hello_again" } }),
      now: () => tick++,
    });

    // The inbound timestamp is what defines the window, and it is old.
    expect(result.state.status).toBe("awaiting_reopen");
    expect(result.actions[0]).toMatchObject({
      type: "sendTemplate",
      template: "hello_again",
      pendingText: "Sí, hasta las 18.",
    });
    // Nothing was appended as a sent reply, because nothing was sent.
    expect(result.state.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("defers and records it, rather than appearing to have answered", async () => {
    const inbound: Inbound = { conversationId: "c1", text: "hola", at: OPENED_AT };
    let tick = OPENED_AT + 30 * HOUR;

    const result = await runTurn(conversation(OPENED_AT), inbound, {
      ...deps({ llm: stubLlm([completion({ text: "Sí." })]).fn, tools: [] }),
      channel: new WhatsAppChannel(),
      now: () => tick++,
    });

    expect(result.actions).toEqual([]);
    expect(result.trace.at(-1)?.outcome).toContain("deferred:window_closed_at");
    expect(result.state.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("reopens as soon as the customer writes again", async () => {
    const reopened: ConversationState = {
      ...conversation(OPENED_AT),
      status: "awaiting_reopen",
    };
    const now = OPENED_AT + 30 * HOUR;
    let tick = now;

    const result = await runTurn(
      reopened,
      { conversationId: "c1", text: "sigo interesado", at: now },
      {
        ...deps({ llm: stubLlm([completion({ text: "¡Hola de nuevo!" })]).fn, tools: [] }),
        channel: new WhatsAppChannel({ templates: { reopen: "hello_again" } }),
        now: () => tick++,
      },
    );

    expect(result.trace[0]).toMatchObject({ step: "window", outcome: "reopened" });
    expect(result.state.status).toBe("agent");
    expect(result.actions).toEqual([{ type: "send", text: "¡Hola de nuevo!" }]);
  });

  it("treats every reply as free-form when no channel is configured", async () => {
    const result = await runTurn(
      conversation(null),
      { conversationId: "c1", text: "hola", at: 1 },
      deps({ llm: stubLlm([completion({ text: "Hola." })]).fn, tools: [] }),
    );

    expect(result.actions).toEqual([{ type: "send", text: "Hola." }]);
  });
});
