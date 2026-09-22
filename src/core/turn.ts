import { TraceBuilder } from "./trace.js";
import { preCheck } from "../guards/index.js";
import { evaluate } from "../policies/index.js";
import { ToolInputError, type Tool, type ToolContext } from "../tools/defineTool.js";
import type { ProviderMessage, ToolCall } from "../providers/types.js";
import type { Answers } from "../classify/types.js";
import type { SendPlan } from "../channels/types.js";
import type { Policy, Verdict } from "../policies/types.js";
import type {
  ConversationState,
  Inbound,
  Message,
  TraceEntry,
  TurnDeps,
  TurnResult,
} from "./types.js";

/**
 * One turn, with every decision recorded and no ambient I/O.
 *
 * "Pure" here means effect-injected, not side-effect-free: it awaits the LLM,
 * the classifier and the tools. What it never does is reach for Date.now,
 * Math.random, fetch or the store. Stub `deps` and the same input produces the
 * same trace, byte for byte — which is what makes the suite deterministic and
 * lets agent-evals replay it.
 *
 * Outward effects are returned as `actions`, never performed. worker.ts is the
 * only place that interprets them.
 */
export async function runTurn(
  state: ConversationState,
  inbound: Inbound,
  deps: TurnDeps,
): Promise<TurnResult> {
  const trace = new TraceBuilder(deps.now);
  const policies = deps.policies ?? [];

  let next: ConversationState = {
    ...state,
    messages: [...state.messages, { role: "user", text: inbound.text, at: inbound.at }],
    lastCustomerMessageAt: inbound.at,
  };

  // The customer writing is what reopens a shut window, so this has to happen
  // before the gates rather than as part of sending.
  if (next.status === "awaiting_reopen") {
    next = { ...next, status: "agent" };
    trace.note("window", "code", "reopened");
  }

  // --- preCheck: gates, no model ---------------------------------------------
  // The inbound is already on the conversation, so a person taking over sees
  // everything that arrived while the agent stayed out of it.
  const gate = preCheck(deps.guards ?? [], { state: next, inbound, now: deps.now() });
  if (gate.type === "skip") {
    trace.note("preCheck", "code", `skipped:${gate.reason}`, gate.detail);
    return { state: next, actions: [], trace: trace.build() };
  }
  trace.note("preCheck", "code", "ok");

  // --- classify: bounded forks, one request, all questions in parallel --------
  let answers: Answers = {};
  if (deps.classifier) {
    const classifier = deps.classifier;
    answers = await trace.step(
      "classify",
      classifier.name === "jev" ? "jev" : "llm",
      () => classifier.classify(classifierState(next, inbound)),
      (value) => ({ outcome: "ok", detail: { answers: value } }),
    );
  }

  const policyCtx = { state: next, inbound, answers, now: deps.now() };

  // --- policies.before(): may hand over before a token is spent ---------------
  const before = await evaluate(policies, "before", policyCtx);
  if (before.verdict.type !== "allow") {
    return terminalVerdict(next, before.verdict, before.policy?.name ?? "policy", trace, "before");
  }

  // --- respond: the LLM writes, tools feed it text ---------------------------
  const toolsByName = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const toolSpecs = deps.tools.map((tool) => tool.spec);
  const transcript: ProviderMessage[] = toTranscript(next.messages);
  const toolContext: ToolContext = { conversationId: next.id, now: deps.now };

  let reply: string | null = null;
  let exhausted = true;
  let toolRan = false;
  let escalation: { reason: string; policy: string } | null = null;

  for (let iteration = 0; iteration < deps.config.maxToolIterations; iteration++) {
    const completion = await trace.step(
      "respond",
      "llm",
      () =>
        deps.llm({
          model: deps.config.model,
          system: deps.config.system,
          messages: transcript,
          tools: toolSpecs,
          maxTokens: deps.config.maxTokens,
        }),
      (value) => ({
        outcome: value.stopReason,
        detail: { iteration, toolCalls: value.toolCalls.map((c) => c.name) },
        usage: value.usage,
        ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
      }),
    );

    if (completion.toolCalls.length === 0) {
      reply = completion.text;
      exhausted = false;
      break;
    }

    transcript.push({
      role: "assistant",
      content: completion.text,
      toolCalls: completion.toolCalls,
    });

    // Every tool_use must be answered with exactly one tool_result, and they
    // must stay adjacent so providers that require batching can group them.
    // Dropping one is an API error; splitting them teaches the model to stop
    // issuing calls in parallel. That holds even once a policy has escalated:
    // the batch is completed, it is simply not sent back to the model.
    for (const call of completion.toolCalls) {
      const result = await handleToolCall({
        call,
        tool: toolsByName.get(call.name),
        escalated: escalation !== null,
        policies,
        policyCtx,
        toolContext,
        trace,
      });

      if (result.ran) toolRan = true;
      if (result.escalate && !escalation) escalation = result.escalate;

      transcript.push({
        role: "tool",
        toolCallId: call.id,
        content: result.text,
        ...(result.isError ? { isError: true } : {}),
      });
    }

    if (escalation) {
      return terminalVerdict(
        next,
        { type: "escalate", reason: escalation.reason },
        escalation.policy,
        trace,
        "onAction",
      );
    }
  }

  // --- outcome ---------------------------------------------------------------
  next = { ...next, turnsWithoutProgress: toolRan ? 0 : next.turnsWithoutProgress + 1 };

  if (exhausted) {
    // The model kept calling tools past the cap. Handing this to a person is the
    // only honest move: we have no reply and no evidence the loop was converging.
    trace.note("respond", "code", "max_tool_iterations", {
      limit: deps.config.maxToolIterations,
    });
    return handoff(next, "max_tool_iterations", trace);
  }

  let text = reply?.trim() ?? "";
  if (text.length === 0) {
    trace.note("send", "code", "skipped:empty_reply");
    return { state: next, actions: [], trace: trace.build() };
  }

  // --- policies.after(): last look at what is about to leave ------------------
  const after = await evaluate(policies, "after", { ...policyCtx, state: next, text });
  if (after.verdict.type === "rewrite" && after.verdict.text !== undefined) {
    trace.note("policy:" + (after.policy?.name ?? "policy"), "code", "rewrite", {
      hook: "after",
      reason: after.verdict.reason,
    });
    text = after.verdict.text;
  } else if (after.verdict.type !== "allow") {
    return terminalVerdict(next, after.verdict, after.policy?.name ?? "policy", trace, "after");
  }

  // --- channel: the transport's own rules, enforced by the runtime ------------
  const plan: SendPlan = deps.channel
    ? deps.channel.plan({ state: next, text, now: deps.now() })
    : { type: "free_form", text };

  if (plan.type === "deferred") {
    // Nothing was sent. Saying so in the trace is the difference between a
    // deferred message and an agent that appears to have answered.
    trace.note("send", "code", `deferred:${plan.reason}`, { chars: text.length });
    return { state: next, actions: [], trace: trace.build() };
  }

  if (plan.type === "template") {
    trace.note("send", "code", `template:${plan.template}`, { reason: plan.reason });
    return {
      state: { ...next, status: "awaiting_reopen" },
      actions: [
        { type: "sendTemplate", template: plan.template, pendingText: text, reason: plan.reason },
        { type: "setStatus", status: "awaiting_reopen", reason: plan.reason },
      ],
      trace: trace.build(),
    };
  }

  next = {
    ...next,
    messages: [...next.messages, { role: "assistant", text, at: deps.now() }],
  };
  trace.note("send", "code", "ok", { chars: text.length });

  return { state: next, actions: [{ type: "send", text }], trace: trace.build() };
}

interface ToolCallOutcome {
  text: string;
  isError: boolean;
  ran: boolean;
  escalate?: { reason: string; policy: string };
}

async function handleToolCall(input: {
  call: ToolCall;
  tool: Tool | undefined;
  escalated: boolean;
  policies: readonly Policy[];
  policyCtx: { state: ConversationState; inbound: Inbound; answers: Answers; now: number };
  toolContext: ToolContext;
  trace: TraceBuilder;
}): Promise<ToolCallOutcome> {
  const { call, tool, escalated, policies, policyCtx, toolContext, trace } = input;
  const step = `tool:${call.name}`;

  // An earlier call in this same batch already handed the conversation over.
  // The remaining calls still need a result, but running them would be acting
  // after we stopped being the one in charge.
  if (escalated) {
    trace.note(step, "code", "not_executed:escalated");
    return {
      text: "Not executed: the conversation was handed to a person.",
      isError: true,
      ran: false,
    };
  }

  if (!tool) {
    trace.note(step, "code", "unknown_tool");
    return { text: `Unknown tool "${call.name}".`, isError: true, ran: false };
  }

  // --- policies.onAction(): every call is inspected before it runs ------------
  let args = call.args;
  const decision = await evaluate(policies, "onAction", { ...policyCtx, tool, call, args });
  const policyName = decision.policy?.name ?? "policy";

  if (decision.verdict.type === "block") {
    trace.note(`policy:${policyName}`, "code", "block", {
      tool: call.name,
      reason: decision.verdict.reason,
    });
    return {
      text: decision.verdict.toolResultText ?? `Blocked by policy: ${decision.verdict.reason}.`,
      isError: true,
      ran: false,
    };
  }

  if (decision.verdict.type === "escalate") {
    trace.note(`policy:${policyName}`, "code", "escalate", {
      tool: call.name,
      reason: decision.verdict.reason,
    });
    return {
      text: `Not executed: handed to a person (${decision.verdict.reason}).`,
      isError: true,
      ran: false,
      escalate: { reason: decision.verdict.reason, policy: policyName },
    };
  }

  if (decision.verdict.type === "rewrite" && decision.verdict.args !== undefined) {
    trace.note(`policy:${policyName}`, "code", "rewrite", {
      tool: call.name,
      reason: decision.verdict.reason,
    });
    args = decision.verdict.args;
  }

  return runTool(tool, args, toolContext, trace);
}

async function runTool(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  trace: TraceBuilder,
): Promise<ToolCallOutcome> {
  try {
    const text = await trace.step(
      `tool:${tool.name}`,
      "code",
      () => tool.execute(args, ctx),
      (value) => ({ outcome: "ok", detail: { args, chars: value.length } }),
    );
    return { text, isError: false, ran: true };
  } catch (error) {
    // Hand the failure back to the model as a tool result rather than killing
    // the turn: a bad argument is usually something it can correct on the next
    // iteration. The trace already recorded the error.
    if (error instanceof ToolInputError) {
      return { text: error.message, isError: true, ran: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Tool "${tool.name}" failed: ${message}`, isError: true, ran: false };
  }
}

/** A policy stopped the turn. Nothing is sent; the trace says who and why. */
function terminalVerdict(
  state: ConversationState,
  verdict: Verdict,
  policyName: string,
  trace: TraceBuilder,
  hook: string,
): TurnResult {
  if (verdict.type === "escalate") {
    trace.note(`policy:${policyName}`, "code", "escalate", { hook, reason: verdict.reason });
    return handoff(state, verdict.reason, trace);
  }

  if (verdict.type === "block") {
    trace.note(`policy:${policyName}`, "code", "block", { hook, reason: verdict.reason });
    return { state, actions: [], trace: trace.build() };
  }

  // A rewrite with nothing to substitute is a policy bug, not a decision.
  trace.note(`policy:${policyName}`, "code", "rewrite:empty", { hook });
  return { state, actions: [], trace: trace.build() };
}

function handoff(state: ConversationState, reason: string, trace: TraceBuilder): TurnResult {
  return {
    state: { ...state, status: "handoff_requested" },
    actions: [{ type: "setStatus", status: "handoff_requested", reason }],
    trace: trace.build(),
  };
}

function toTranscript(messages: readonly Message[]): ProviderMessage[] {
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user" as const, content: message.text }
      : // A human taking over speaks as the business, so the model sees those
        // turns as its own previous replies.
        { role: "assistant" as const, content: message.text },
  );
}

/** Compact view of the conversation handed to the classifier. */
function classifierState(state: ConversationState, inbound: Inbound): Record<string, unknown> {
  return {
    history: state.messages
      .slice(-10, -1)
      .map((message) => ({ role: message.role, text: message.text })),
    inbound: inbound.text,
  };
}

/** A fresh conversation, for stores and tests. */
export function emptyConversation(id: string): ConversationState {
  return {
    id,
    status: "agent",
    messages: [],
    lastCustomerMessageAt: null,
    turnsWithoutProgress: 0,
  };
}

export type { TraceEntry };
