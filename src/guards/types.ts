import type { ConversationState, Inbound } from "../core/types.js";

export interface GuardContext {
  state: ConversationState;
  inbound: Inbound;
  /** Read from the injected clock, never from Date.now. */
  now: number;
}

export type GuardVerdict =
  | { type: "proceed" }
  | { type: "skip"; reason: string; detail?: Record<string, unknown> };

/**
 * A gate that runs before any model is consulted.
 *
 * Guards are pure and synchronous on purpose: this is the "code decides" colour.
 * A kill switch that needs a network call is not a kill switch, and a gate that
 * costs a token is not free to run on every turn.
 */
export interface Guard {
  readonly name: string;
  check(ctx: GuardContext): GuardVerdict;
}

export const proceed: GuardVerdict = { type: "proceed" };

export function skip(reason: string, detail?: Record<string, unknown>): GuardVerdict {
  return { type: "skip", reason, ...(detail ? { detail } : {}) };
}
