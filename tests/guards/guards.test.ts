import { describe, expect, it } from "vitest";
import {
  debounce,
  humanTakeover,
  killSwitch,
  paused,
  preCheck,
  rateLimit,
  standardGuards,
} from "../../src/guards/index.js";
import { emptyConversation } from "../../src/core/turn.js";
import type { ConversationState, Inbound } from "../../src/core/types.js";
import type { GuardContext } from "../../src/guards/types.js";

const inbound: Inbound = { conversationId: "c1", text: "hola", at: 1_000 };

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return { state: emptyConversation("c1"), inbound, now: 1_000, ...overrides };
}

function withStatus(status: ConversationState["status"]): ConversationState {
  return { ...emptyConversation("c1"), status };
}

describe("killSwitch", () => {
  it("re-reads the predicate on every turn so the switch can actually be flipped", () => {
    let enabled = true;
    const guard = killSwitch(() => enabled);

    expect(guard.check(ctx())).toEqual({ type: "proceed" });
    enabled = false;
    expect(guard.check(ctx())).toMatchObject({ type: "skip", reason: "killswitch" });
  });
});

describe("paused", () => {
  it("skips a parked conversation", () => {
    expect(paused().check(ctx({ state: withStatus("paused") }))).toMatchObject({
      reason: "paused",
    });
    expect(paused().check(ctx())).toEqual({ type: "proceed" });
  });
});

describe("humanTakeover", () => {
  it("stays out while a human owns or is claiming the conversation", () => {
    expect(humanTakeover().check(ctx({ state: withStatus("human") }))).toMatchObject({
      reason: "human:human",
    });
    expect(humanTakeover().check(ctx({ state: withStatus("handoff_requested") }))).toMatchObject({
      reason: "human:handoff_requested",
    });
    expect(humanTakeover().check(ctx())).toEqual({ type: "proceed" });
  });
});

describe("debounce", () => {
  it("waits for a message that just arrived", () => {
    const verdict = debounce(30_000).check(ctx({ now: 1_000 + 5_000 }));
    expect(verdict).toMatchObject({ type: "skip", reason: "debounce" });
    expect(verdict.type === "skip" ? verdict.detail : {}).toMatchObject({ ageMs: 5_000 });
  });

  it("proceeds once the customer has stopped typing", () => {
    expect(debounce(30_000).check(ctx({ now: 1_000 + 30_000 }))).toEqual({ type: "proceed" });
  });
});

describe("rateLimit", () => {
  it("counts what the agent sent, not what arrived", () => {
    // The failure this protects against is a loop answering itself, so inbound
    // volume must not consume the budget.
    const state: ConversationState = {
      ...emptyConversation("c1"),
      messages: [
        { role: "user", text: "1", at: 900 },
        { role: "user", text: "2", at: 950 },
        { role: "user", text: "3", at: 980 },
      ],
    };

    expect(rateLimit({ max: 2, windowMs: 60_000 }).check(ctx({ state }))).toEqual({
      type: "proceed",
    });
  });

  it("skips once the agent has hit its budget inside the window", () => {
    const state: ConversationState = {
      ...emptyConversation("c1"),
      messages: [
        { role: "assistant", text: "a", at: 900 },
        { role: "assistant", text: "b", at: 950 },
      ],
    };

    expect(rateLimit({ max: 2, windowMs: 60_000 }).check(ctx({ state }))).toMatchObject({
      reason: "rate_limit",
    });
  });

  it("forgets replies that fell out of the window", () => {
    const state: ConversationState = {
      ...emptyConversation("c1"),
      messages: [
        { role: "assistant", text: "old", at: 0 },
        { role: "assistant", text: "older", at: 1 },
      ],
    };

    expect(
      rateLimit({ max: 2, windowMs: 500 }).check(ctx({ state, now: 10_000 })),
    ).toEqual({ type: "proceed" });
  });
});

describe("preCheck", () => {
  it("returns the first skip and stops evaluating", () => {
    let reached = false;
    const verdict = preCheck(
      [
        killSwitch(() => false),
        {
          name: "spy",
          check: () => {
            reached = true;
            return { type: "proceed" as const };
          },
        },
      ],
      ctx(),
    );

    expect(verdict).toMatchObject({ reason: "killswitch" });
    expect(reached).toBe(false);
  });

  it("proceeds when there are no guards at all", () => {
    expect(preCheck([], ctx())).toEqual({ type: "proceed" });
  });
});

describe("standardGuards", () => {
  it("orders absolute stops before ownership before pacing", () => {
    const names = standardGuards({
      killSwitch: () => true,
      debounceMs: 30_000,
      rateLimit: { max: 5, windowMs: 60_000 },
    }).map((guard) => guard.name);

    expect(names).toEqual(["killSwitch", "paused", "humanTakeover", "debounce", "rateLimit"]);
  });

  it("includes only the optional gates that were configured", () => {
    expect(standardGuards().map((guard) => guard.name)).toEqual(["paused", "humanTakeover"]);
  });
});
