import { TraceBuilder } from "./trace.js";
import { ToolInputError, type Tool, type ToolContext } from "../tools/defineTool.js";
import type { ProviderMessage } from "../providers/types.js";
import type {
  Action,
  ConversationState,
  Inbound,
  Message,
  TurnDeps,
  TurnResult,
} from "./types.js";

/**
 * One turn, with every decision recorded and no ambient I/O.
 *
 * "Pure" here means effect-injected, not side-effect-free: it awaits the LLM and
 * the tools. What it never does is reach for Date.now, Math.random, fetch or the
 * store. Stub `deps` and the same input produces the same trace, byte for byte —
 * which is what makes the suite deterministic and lets agent-evals replay it.
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
  const actions: Action[] = [];

  let next: ConversationState = {
    ...state,
    messages: [...state.messages, { role: "user", text: inbound.text, at: inbound.at }],
    lastCustomerMessageAt: inbound.at,
  };

  // --- classify: bounded forks, one request, all questions in parallel --------
  if (deps.classifier) {
    const classifier = deps.classifier;
    await trace.step(
      "classify",
      classifier.name === "jev" ? "jev" : "llm",
      () => classifier.classify(classifierState(next, inbound)),
      (answers) => ({ outcome: "ok", detail: { answers } }),
    );
  }

  // --- respond: the LLM writes, tools feed it text ---------------------------
  const toolsByName = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const toolSpecs = deps.tools.map((tool) => tool.spec);
  const transcript: ProviderMessage[] = toTranscript(next.messages);
  const toolContext: ToolContext = { conversationId: next.id, now: deps.now };

  let reply: string | null = null;
  let exhausted = true;

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
    // issuing calls in parallel.
    for (const call of completion.toolCalls) {
      // Policy hook (M2): policies.onAction() decides allow/block/escalate/
      // rewrite here, before the tool runs. A blocked call still gets a
      // tool_result carrying the reason.
      const tool = toolsByName.get(call.name);

      if (!tool) {
        trace.note("tool:" + call.name, "code", "unknown_tool");
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          content: `Unknown tool "${call.name}".`,
          isError: true,
        });
        continue;
      }

      const result = await runTool(tool, call.args, toolContext, trace);
      transcript.push({
        role: "tool",
        toolCallId: call.id,
        content: result.text,
        ...(result.isError ? { isError: true } : {}),
      });
    }
  }

  // --- outcome ---------------------------------------------------------------
  if (exhausted) {
    // The model kept calling tools past the cap. Handing this to a person is the
    // only honest move: we have no reply and no evidence the loop was converging.
    trace.note("respond", "code", "max_tool_iterations", {
      limit: deps.config.maxToolIterations,
    });
    next = { ...next, status: "handoff_requested" };
    actions.push({
      type: "setStatus",
      status: "handoff_requested",
      reason: "max_tool_iterations",
    });
    return { state: next, actions, trace: trace.build() };
  }

  const text = reply?.trim() ?? "";
  if (text.length === 0) {
    trace.note("send", "code", "skipped:empty_reply");
    return { state: next, actions, trace: trace.build() };
  }

  // Policy hook (M2): policies.after() inspects the outbound message here.
  next = {
    ...next,
    messages: [...next.messages, { role: "assistant", text, at: deps.now() }],
  };
  actions.push({ type: "send", text });
  trace.note("send", "code", "ok", { chars: text.length });

  return { state: next, actions, trace: trace.build() };
}

async function runTool(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  trace: TraceBuilder,
): Promise<{ text: string; isError: boolean }> {
  try {
    const text = await trace.step(
      `tool:${tool.name}`,
      "code",
      () => tool.execute(args, ctx),
      (value) => ({ outcome: "ok", detail: { args, chars: value.length } }),
    );
    return { text, isError: false };
  } catch (error) {
    // Hand the failure back to the model as a tool result rather than killing
    // the turn: a bad argument is usually something it can correct on the next
    // iteration. The trace already recorded the error.
    if (error instanceof ToolInputError) {
      return { text: error.message, isError: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Tool "${tool.name}" failed: ${message}`, isError: true };
  }
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
