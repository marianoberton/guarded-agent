import type { Completion, CompletionRequest, Usage } from "../providers/types.js";
import type { Classifier } from "../classify/types.js";
import type { Tool } from "../tools/defineTool.js";
import type { Guard } from "../guards/types.js";

export type Role = "user" | "assistant" | "human";

export interface Message {
  role: Role;
  text: string;
  /** Wall-clock ms. Supplied by the channel, never read from the ambient clock. */
  at: number;
}

export type ConversationStatus =
  | "agent"
  | "handoff_requested"
  | "human"
  | "awaiting_reopen"
  | "paused";

export interface ConversationState {
  id: string;
  status: ConversationStatus;
  messages: Message[];
  /** Drives the WhatsApp 24h window (M3). Null until the customer writes. */
  lastCustomerMessageAt: number | null;
  /** Feeds maxTurnsWithoutProgress (M2). */
  turnsWithoutProgress: number;
}

export interface Inbound {
  conversationId: string;
  text: string;
  at: number;
}

/**
 * Outward effects. runTurn never performs these — it returns them and worker.ts
 * is the only place that interprets them. That is what keeps runTurn testable.
 */
export type Action =
  | { type: "send"; text: string }
  | { type: "setStatus"; status: ConversationStatus; reason: string };

/** Who made a decision. The whole point of the library is that this is recorded. */
export type Decider = "code" | "jev" | "llm";

export interface TraceEntry {
  /** "preCheck" | "classify" | "respond" | "tool:lookupStock" | "policy:veto" | "send" */
  step: string;
  by: Decider;
  /** "ok" | "skipped:paused" | "allow" | "block" | "escalate" | "error" */
  outcome: string;
  detail?: Record<string, unknown>;
  latencyMs: number;
  usage?: Usage;
  costUsd?: number;
}

export interface TurnResult {
  state: ConversationState;
  actions: Action[];
  trace: TraceEntry[];
}

export type LlmFn = (req: CompletionRequest) => Promise<Completion>;

export interface TurnConfig {
  system: string;
  model: string;
  maxTokens: number;
  /** Hard stop on the tool loop, so a confused model cannot spin forever. */
  maxToolIterations: number;
}

/**
 * Everything runTurn is allowed to reach for. No ambient Date.now, no Math.random,
 * no fetch, no store. Stub these and the same input yields the same trace, byte
 * for byte — which is what makes the suite deterministic and replayable.
 */
export interface TurnDeps {
  llm: LlmFn;
  classifier?: Classifier;
  /** Deterministic gates, run before any model is consulted. */
  guards?: readonly Guard[];
  tools: readonly Tool[];
  now: () => number;
  newId: () => string;
  config: TurnConfig;
}
