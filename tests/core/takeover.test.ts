import { describe, expect, it } from "vitest";
import {
  acceptHandoff,
  appendHumanMessage,
  releaseHandoff,
  releaseIfInactive,
  requestHandoff,
} from "../../src/core/takeover.js";
import { emptyConversation } from "../../src/core/turn.js";
import { humanTakeover, preCheck } from "../../src/guards/index.js";
import type { ConversationState } from "../../src/core/types.js";

const inbound = { conversationId: "c1", text: "hola", at: 5_000 };

describe("takeover state machine", () => {
  it("walks the full cycle: agent -> handoff_requested -> human -> agent", () => {
    let state = emptyConversation("c1");
    expect(state.status).toBe("agent");

    state = requestHandoff(state, "price_negotiation").state;
    expect(state.status).toBe("handoff_requested");

    state = acceptHandoff(state).state;
    expect(state.status).toBe("human");

    state = releaseHandoff(state).state;
    expect(state.status).toBe("agent");
  });

  it("emits a setStatus action for every real transition", () => {
    const requested = requestHandoff(emptyConversation("c1"), "needs_human");
    expect(requested.actions).toEqual([
      { type: "setStatus", status: "handoff_requested", reason: "needs_human" },
    ]);

    const accepted = acceptHandoff(requested.state);
    expect(accepted.actions).toEqual([
      { type: "setStatus", status: "human", reason: "human_accepted" },
    ]);
  });

  it("is idempotent, so a second click does not re-emit", () => {
    const once = requestHandoff(emptyConversation("c1"), "a");
    const twice = requestHandoff(once.state, "b");
    expect(twice.actions).toEqual([]);
    expect(twice.state).toBe(once.state);
  });

  it("does not release a conversation the agent already owns", () => {
    const released = releaseHandoff(emptyConversation("c1"));
    expect(released.actions).toEqual([]);
  });
});

describe("the agent stays out while a human holds the conversation", () => {
  it("skips every turn in handoff_requested and human", () => {
    // A handoff that only takes effect on the next message is not a handoff,
    // so the guard has to run on every turn.
    for (const status of ["handoff_requested", "human"] as const) {
      const state: ConversationState = { ...emptyConversation("c1"), status };
      expect(preCheck([humanTakeover()], { state, inbound, now: 5_000 })).toMatchObject({
        type: "skip",
      });
    }
  });

  it("resumes once the conversation is released", () => {
    const state = releaseHandoff({ ...emptyConversation("c1"), status: "human" }).state;
    expect(preCheck([humanTakeover()], { state, inbound, now: 5_000 })).toEqual({
      type: "proceed",
    });
  });
});

describe("human messages", () => {
  it("are kept in the transcript as business turns", () => {
    const state = appendHumanMessage(
      { ...emptyConversation("c1"), status: "human" },
      "Te puedo dejar en 17.500.",
      6_000,
    );
    expect(state.messages.at(-1)).toEqual({
      role: "human",
      text: "Te puedo dejar en 17.500.",
      at: 6_000,
    });
  });

  it("survive release untouched when no summary is supplied", () => {
    // They are already correct as they stand: from the customer's side, the
    // business said them.
    let state = appendHumanMessage({ ...emptyConversation("c1"), status: "human" }, "a", 6_000);
    state = appendHumanMessage(state, "b", 6_100);
    const released = releaseHandoff(state).state;

    expect(released.messages.map((m) => m.role)).toEqual(["human", "human"]);
  });

  it("collapse into one line of context when a summary is supplied", () => {
    let state = appendHumanMessage({ ...emptyConversation("c1"), status: "human" }, "a", 6_000);
    state = appendHumanMessage(state, "b", 6_100);

    const released = releaseHandoff(state, {
      summary: "Agreed USD 17.500 with the customer.",
    }).state;

    expect(released.messages).toEqual([
      { role: "assistant", text: "Agreed USD 17.500 with the customer.", at: 6_100 },
    ]);
  });

  it("clears the no-progress counter on release", () => {
    // Whatever the agent was stuck on is the human's problem now; carrying the
    // count over would escalate again on the very next turn.
    const state: ConversationState = {
      ...emptyConversation("c1"),
      status: "human",
      turnsWithoutProgress: 9,
    };
    expect(releaseHandoff(state).state.turnsWithoutProgress).toBe(0);
  });
});

describe("releaseIfInactive", () => {
  it("returns the conversation when the person went quiet", () => {
    // One forgotten tab must not silence an agent forever.
    const state = appendHumanMessage(
      { ...emptyConversation("c1"), status: "human" },
      "un momento",
      1_000,
    );

    const released = releaseIfInactive(state, { timeoutMs: 30 * 60_000, now: 1_000 + 31 * 60_000 });
    expect(released.state.status).toBe("agent");
    expect(released.actions).toEqual([
      { type: "setStatus", status: "agent", reason: "inactivity_timeout" },
    ]);
  });

  it("leaves an actively held conversation alone", () => {
    const state = appendHumanMessage(
      { ...emptyConversation("c1"), status: "human" },
      "ya te contesto",
      1_000,
    );
    expect(
      releaseIfInactive(state, { timeoutMs: 30 * 60_000, now: 1_000 + 60_000 }).state.status,
    ).toBe("human");
  });

  it("times out a handoff nobody ever accepted", () => {
    const state: ConversationState = {
      ...emptyConversation("c1"),
      status: "handoff_requested",
      messages: [{ role: "user", text: "hola", at: 1_000 }],
    };
    expect(
      releaseIfInactive(state, { timeoutMs: 10 * 60_000, now: 1_000 + 11 * 60_000 }).state.status,
    ).toBe("agent");
  });

  it("ignores a conversation the agent already owns", () => {
    const state = emptyConversation("c1");
    expect(releaseIfInactive(state, { timeoutMs: 1, now: 9_999_999 }).actions).toEqual([]);
  });
});
