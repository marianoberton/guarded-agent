import { allow, block, escalate, type Policy, type Verdict } from "./types.js";
import { readChoice, readNoul } from "../classify/types.js";
import type { NoulQuestion } from "../classify/types.js";
import type { JevProvider } from "../providers/jev.js";
import type { Tool } from "../tools/defineTool.js";
import type { ActionContext, AfterContext, BeforeContext } from "./types.js";

export type { ActionContext, AfterContext, BeforeContext, Policy, Verdict } from "./types.js";
export { allow, block, escalate, rewrite } from "./types.js";

/**
 * Runs a hook across every policy in declaration order. The first non-allow
 * verdict wins and nothing after it runs.
 *
 * Order is the caller's and it matters. It is arbitrary but it has to be
 * something, and "first to object wins" is the rule that is easy to reason
 * about when reading a policy list top to bottom.
 */
export async function evaluate<C>(
  policies: readonly Policy[],
  hook: "before" | "onAction" | "after",
  ctx: C,
): Promise<{ verdict: Verdict; policy?: Policy }> {
  for (const policy of policies) {
    const fn = policy[hook] as ((c: C) => Promise<Verdict> | Verdict) | undefined;
    if (!fn) continue;
    const verdict = await fn.call(policy, ctx);
    if (verdict.type !== "allow") return { verdict, policy };
  }
  return { verdict: allow };
}

// --- escalateWhen -------------------------------------------------------------

export type EscalateWhenOptions =
  | Record<string, string>
  | { noul: string; above: number }
  | { choice: string; is: string | string[] };

/**
 * Hands the conversation to a person when the classifier says so.
 *
 * Two forms, both reading answers produced earlier in the same turn:
 *
 *   escalateWhen({ intent: "price_negotiation" })
 *   escalateWhen({ noul: "needs_human", above: 0.85 })
 *
 * The threshold is yours. There is no universally right number — measure it
 * against labelled outcomes rather than picking one that sounds careful.
 */
export function escalateWhen(options: EscalateWhenOptions): Policy {
  if ("noul" in options && typeof options.above === "number") {
    const { noul: key, above } = options;
    return {
      name: `escalateWhen(${key}>${above})`,
      before: ({ answers }: BeforeContext) => {
        const value = readNoul(answers, key);
        return value > above ? escalate(`${key}=${value.toFixed(2)}>${above}`) : allow;
      },
    };
  }

  const pairs =
    "choice" in options && typeof options.choice === "string"
      ? [[options.choice, options.is] as [string, string | string[]]]
      : Object.entries(options as Record<string, string>);

  return {
    name: `escalateWhen(${pairs.map(([k, v]) => `${k}=${String(v)}`).join(",")})`,
    before: ({ answers }: BeforeContext) => {
      for (const [key, expected] of pairs) {
        const { choice } = readChoice(answers, key);
        const wanted = Array.isArray(expected) ? expected : [expected];
        if (wanted.includes(choice)) return escalate(`${key}=${choice}`);
      }
      return allow;
    },
  };
}

// --- veto ---------------------------------------------------------------------

export interface VetoOptions<A> {
  /**
   * Pass the tool itself and the argument type is inferred; pass a name and you
   * are on your own for typing, which is what the explicit parameter is for.
   */
  tool: Tool<A> | string;
  /** Called with the arguments as they stand. Return true to block the call. */
  when: (ctx: { args: A; call: ActionContext["call"]; state: ActionContext["state"] }) => boolean;
  reason?: string;
  /** What the model is told, so it can take a different route. */
  toolResultText?: string;
}

/**
 * Blocks a specific tool call on a condition you can express in code.
 *
 * This is the deterministic half of the veto story: no model, no probability,
 * no threshold to tune. If the rule can be written as a predicate, write it
 * here rather than asking Jev.
 */
export function veto<A = Record<string, unknown>>(options: VetoOptions<A>): Policy {
  const toolName = typeof options.tool === "string" ? options.tool : options.tool.name;
  const reason = options.reason ?? `veto:${toolName}`;
  return {
    name: `veto(${toolName})`,
    onAction: (ctx: ActionContext) => {
      if (ctx.call.name !== toolName) return allow;
      const hit = options.when({
        args: ctx.args as A,
        call: ctx.call,
        state: ctx.state,
      });
      return hit
        ? block(
            reason,
            options.toolResultText ??
              `Blocked by policy: ${reason}. Do not retry this; offer to involve a person instead.`,
          )
        : allow;
    },
  };
}

// --- requireApproval ----------------------------------------------------------

export interface RequireApprovalOptions {
  tools: readonly string[];
  reason?: string;
}

/** Sends the conversation to a person before a named tool is allowed to run. */
export function requireApproval(options: RequireApprovalOptions): Policy {
  const names = new Set(options.tools);
  return {
    name: `requireApproval(${options.tools.join(",")})`,
    onAction: (ctx: ActionContext) =>
      names.has(ctx.call.name)
        ? escalate(options.reason ?? `approval_required:${ctx.call.name}`)
        : allow,
  };
}

// --- riskGate -----------------------------------------------------------------

export interface RiskGateOptions {
  jev: JevProvider;
  question: NoulQuestion;
  blockAbove: number;
  escalateAbove: number;
  /**
   * Only side-effecting tools are inspected by default. Asking whether reading
   * a stock list is risky costs a request and answers itself.
   */
  includeReadOnly?: boolean;
}

/**
 * Asks Jev whether a proposed action is something the business would not want
 * done automatically.
 *
 * This is the probabilistic half of the veto story, and the reason Policy hooks
 * are async. Two thresholds, both the caller's: above `blockAbove` the call is
 * refused, above `escalateAbove` a person takes over.
 *
 * Jev cannot return an invalid type here. It can return a wrong valid one —
 * which is why these numbers should be set from measurement, not intuition.
 */
export function riskGate(options: RiskGateOptions): Policy {
  return {
    name: "riskGate",
    onAction: async (ctx: ActionContext): Promise<Verdict> => {
      if (!options.includeReadOnly && !ctx.tool.sideEffecting) return allow;

      const answers = await options.jev.decide(
        {
          action: ctx.call.name,
          description: ctx.tool.description,
          arguments: ctx.args,
          inbound: ctx.inbound.text,
        },
        { risk: options.question },
      );

      const risk = readNoul(answers, "risk");

      if (risk > options.blockAbove) {
        return block(
          `risk=${risk.toFixed(2)}>${options.blockAbove}`,
          "Blocked by policy: this action is not allowed automatically.",
        );
      }
      if (risk > options.escalateAbove) {
        return escalate(`risk=${risk.toFixed(2)}>${options.escalateAbove}`);
      }
      return allow;
    },
  };
}

// --- maxTurnsWithoutProgress --------------------------------------------------

/**
 * Escalates when the agent has been talking without doing anything.
 *
 * "Progress" means a tool ran — the agent acted rather than only produced
 * prose. A purely conversational agent that never calls tools should not use
 * this policy; for one that is supposed to book visits and send quotes, a run
 * of replies with no tool call is the shape of a conversation going nowhere.
 */
export function maxTurnsWithoutProgress(limit: number): Policy {
  return {
    name: `maxTurnsWithoutProgress(${limit})`,
    before: ({ state }: BeforeContext) =>
      state.turnsWithoutProgress >= limit
        ? escalate(`no_progress:${state.turnsWithoutProgress}`)
        : allow,
  };
}

// --- notContains --------------------------------------------------------------

/**
 * Refuses to send an outbound message containing forbidden words.
 *
 * The last line of defence for promises the business cannot keep — a model
 * that offers a discount has made one regardless of what the prompt said.
 */
export function notContains(words: readonly string[], reason = "forbidden_term"): Policy {
  const needles = words.map((word) => word.toLowerCase());
  return {
    name: `notContains(${words.join(",")})`,
    after: ({ text }: AfterContext) => {
      const haystack = text.toLowerCase();
      const hit = needles.find((needle) => haystack.includes(needle));
      return hit ? block(`${reason}:${hit}`) : allow;
    },
  };
}
