import type { ConversationState, Inbound } from "../core/types.js";
import type { Answers } from "../classify/types.js";
import type { Tool } from "../tools/defineTool.js";
import type { ToolCall } from "../providers/types.js";

/**
 * What a policy decided about a proposed action.
 *
 * `rewrite` carries the replacement, not an instruction to produce one: a
 * policy that asks the model to try again has handed the decision back to the
 * thing it was supposed to be constraining.
 */
export type Verdict =
  | { type: "allow" }
  | { type: "block"; reason: string; toolResultText?: string }
  | { type: "escalate"; reason: string }
  | { type: "rewrite"; reason: string; args?: unknown; text?: string };

export const allow: Verdict = { type: "allow" };

export function block(reason: string, toolResultText?: string): Verdict {
  return { type: "block", reason, ...(toolResultText ? { toolResultText } : {}) };
}

export function escalate(reason: string): Verdict {
  return { type: "escalate", reason };
}

export function rewrite(reason: string, patch: { args?: unknown; text?: string }): Verdict {
  return { type: "rewrite", reason, ...patch };
}

interface BaseContext {
  state: ConversationState;
  inbound: Inbound;
  /** Whatever the classifier returned this turn. Empty when none is configured. */
  answers: Answers;
  now: number;
}

export type BeforeContext = BaseContext;

export interface ActionContext extends BaseContext {
  tool: Tool;
  call: ToolCall;
  /** The arguments as they stand, already rewritten by any earlier policy. */
  args: unknown;
}

export interface AfterContext extends BaseContext {
  /** The outbound message as it stands, already rewritten by any earlier policy. */
  text: string;
}

/**
 * A policy inspects a proposed action and may veto it.
 *
 * Hooks are async because a policy is allowed to ask Jev — that is the point of
 * riskGate. They are evaluated in declaration order and the first non-allow
 * verdict short-circuits the rest.
 */
export interface Policy {
  readonly name: string;
  /** Runs once per turn, after classification, before the model is called. */
  before?(ctx: BeforeContext): Promise<Verdict> | Verdict;
  /** Runs for every tool call, before the tool executes. */
  onAction?(ctx: ActionContext): Promise<Verdict> | Verdict;
  /** Runs once, on the outbound message, before it is sent. */
  after?(ctx: AfterContext): Promise<Verdict> | Verdict;
}
