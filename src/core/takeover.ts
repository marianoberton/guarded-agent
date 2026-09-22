import type { Action, ConversationState, Message } from "./types.js";

/**
 * The takeover state machine.
 *
 *   agent ──(escalate | human clicks)──▶ handoff_requested ──(accept)──▶ human
 *     ▲                                                                    │
 *     └──────────────(release | inactivity timeout)────────────────────────┘
 *
 * Every transition is a pure function over state. The guard that keeps the
 * agent out while a human holds the conversation lives in guards/, and it runs
 * on every turn — a handoff that only takes effect on the next message is not a
 * handoff.
 */

export interface Transition {
  state: ConversationState;
  actions: Action[];
}

/** The agent, or an operator, asks for a person. */
export function requestHandoff(state: ConversationState, reason: string): Transition {
  if (state.status === "human" || state.status === "handoff_requested") {
    return { state, actions: [] };
  }
  return {
    state: { ...state, status: "handoff_requested" },
    actions: [{ type: "setStatus", status: "handoff_requested", reason }],
  };
}

/** A person picks the conversation up. */
export function acceptHandoff(state: ConversationState, reason = "human_accepted"): Transition {
  if (state.status === "human") return { state, actions: [] };
  return {
    state: { ...state, status: "human" },
    actions: [{ type: "setStatus", status: "human", reason }],
  };
}

/** A message written by the person who took over. */
export function appendHumanMessage(
  state: ConversationState,
  text: string,
  at: number,
): ConversationState {
  return { ...state, messages: [...state.messages, { role: "human", text, at }] };
}

export interface ReleaseOptions {
  reason?: string;
  /**
   * Replaces the run of human messages with one line of context.
   *
   * Optional because summarising well needs a model, and this module is pure.
   * Left out, the human's messages stay in the transcript as they are — which
   * is already correct, since from the customer's side the business said them.
   * Supply a summary when the handover was long enough that the detail is noise.
   */
  summary?: string;
  at?: number;
}

/** The person hands the conversation back, or an inactivity timeout does it for them. */
export function releaseHandoff(state: ConversationState, options: ReleaseOptions = {}): Transition {
  const reason = options.reason ?? "human_released";
  if (state.status !== "human" && state.status !== "handoff_requested") {
    return { state, actions: [] };
  }

  const messages =
    options.summary === undefined
      ? state.messages
      : collapseHumanMessages(
          state.messages,
          options.summary,
          options.at ?? lastAt(state.messages),
        );

  return {
    state: {
      ...state,
      status: "agent",
      messages,
      // The agent is starting fresh; whatever it was stuck on is the human's
      // problem now, and holding the old count would escalate again immediately.
      turnsWithoutProgress: 0,
    },
    actions: [{ type: "setStatus", status: "agent", reason }],
  };
}

export interface InactivityOptions {
  /** How long a human may hold a conversation without writing before it reverts. */
  timeoutMs: number;
  now: number;
}

/**
 * Returns the conversation to the agent when the person who claimed it went
 * quiet. Without this, one forgotten tab silences an agent forever.
 */
export function releaseIfInactive(
  state: ConversationState,
  options: InactivityOptions,
): Transition {
  if (state.status !== "human" && state.status !== "handoff_requested") {
    return { state, actions: [] };
  }

  const lastHumanAt = lastAtFor(state.messages, "human");
  const since = lastHumanAt ?? lastAt(state.messages);
  if (options.now - since < options.timeoutMs) return { state, actions: [] };

  return releaseHandoff(state, { reason: "inactivity_timeout" });
}

function collapseHumanMessages(
  messages: readonly Message[],
  summary: string,
  at: number,
): Message[] {
  const kept = messages.filter((message) => message.role !== "human");
  return [...kept, { role: "assistant", text: summary, at }];
}

function lastAt(messages: readonly Message[]): number {
  return messages.at(-1)?.at ?? 0;
}

function lastAtFor(messages: readonly Message[], role: Message["role"]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === role) return message.at;
  }
  return null;
}
