import type { TraceEntry } from "./types.js";
import type { Store, StoredTurn } from "../stores/types.js";
import type { Answer } from "../classify/types.js";

/**
 * Renders the chain of decisions for one turn: who decided what, with what
 * probability, at what cost.
 *
 * This is the debugging story. When an agent does something surprising in
 * production the question is never "what did the model say" — it is "which of
 * the three colours made this call, and on what evidence". A trace that cannot
 * answer that is just a log.
 */
export function explain(turn: StoredTurn): string {
  const lines: string[] = [
    `turn ${turn.id}  conversation ${turn.conversationId}`,
    `inbound: ${JSON.stringify(turn.inbound)}`,
    "",
  ];

  for (const entry of turn.trace) {
    lines.push(renderEntry(entry));
    lines.push(...renderAnswers(entry));
  }

  lines.push("", renderActions(turn), renderTotals(turn.trace));
  return lines.join("\n");
}

/** Looks the turn up and renders it. Returns null when there is no such turn. */
export async function explainTurn(store: Store, turnId: string): Promise<string | null> {
  const turn = await store.getTurn(turnId);
  return turn ? explain(turn) : null;
}

function renderEntry(entry: TraceEntry): string {
  const cost = entry.costUsd !== undefined ? `  $${entry.costUsd.toFixed(6)}` : "";
  const tokens = entry.usage
    ? `  ${entry.usage.inputTokens}in/${entry.usage.outputTokens}out`
    : "";
  return `${entry.by.padEnd(4)}  ${entry.step.padEnd(22)} ${entry.outcome.padEnd(20)} ${`${entry.latencyMs}ms`.padStart(8)}${tokens}${cost}`;
}

/**
 * Classifier answers get their own indented block. The probability is the point
 * — a decision recorded as "price_negotiation" without the 0.94 next to it
 * cannot be argued with later.
 */
function renderAnswers(entry: TraceEntry): string[] {
  const answers = entry.detail?.["answers"];
  if (!answers || typeof answers !== "object") return [];

  return Object.entries(answers as Record<string, Answer>).map(([key, answer]) =>
    `        ${key.padEnd(18)} ${renderAnswer(answer)}`,
  );
}

function renderAnswer(answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return `= ${answer.noul.toFixed(2)}${confidence(answer.confidence)}`;
    case "choice":
      return `= ${answer.choice}${confidence(answer.confidence)}`;
    case "score":
      return `= ${answer.score.toFixed(2)}${confidence(answer.confidence)}`;
    default:
      return "= ?";
  }
}

function confidence(value: number | undefined): string {
  return value === undefined ? "" : `  conf=${value.toFixed(2)}`;
}

function renderActions(turn: StoredTurn): string {
  if (turn.actions.length === 0) return "actions: (none)";
  const rendered = turn.actions.map((action) =>
    action.type === "send" ? "send" : `setStatus:${action.status}(${action.reason})`,
  );
  return `actions: ${rendered.join(", ")}`;
}

function renderTotals(trace: readonly TraceEntry[]): string {
  let latencyMs = 0;
  let tokens = 0;
  let costUsd = 0;
  let hasCost = false;

  for (const entry of trace) {
    latencyMs += entry.latencyMs;
    if (entry.usage) tokens += entry.usage.inputTokens + entry.usage.outputTokens;
    if (entry.costUsd !== undefined) {
      costUsd += entry.costUsd;
      hasCost = true;
    }
  }

  const cost = hasCost ? `  $${costUsd.toFixed(6)}` : "";
  return `total: ${latencyMs}ms  ${tokens} tokens${cost}`;
}
