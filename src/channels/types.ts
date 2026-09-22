import type { ConversationState } from "../core/types.js";

/**
 * What may actually leave, given the channel's rules right now.
 *
 * `deferred` is not an error: it is the channel saying the message cannot be
 * delivered under its rules and no template was configured to reopen the
 * conversation. Losing that silently is how agents end up appearing to have
 * answered when nothing was sent.
 */
export type SendPlan =
  | { type: "free_form"; text: string }
  | { type: "template"; template: string; pendingText: string; reason: string }
  | { type: "deferred"; pendingText: string; reason: string };

export interface PlanInput {
  state: ConversationState;
  text: string;
  /** Read from the injected clock, never from Date.now. */
  now: number;
}

/**
 * A channel owns the rules of its transport, not the transport itself.
 *
 * `plan` is pure and synchronous so the rules can be tested against a fake
 * clock. Actually putting bytes on the wire is the caller's — the library does
 * not ship a Meta API client, and a channel that needed one could not be
 * unit-tested.
 */
export interface Channel {
  readonly name: string;
  plan(input: PlanInput): SendPlan;
}
