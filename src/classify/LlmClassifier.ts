import type { Answer, Answers, Classifier, Question, QuestionMap } from "./types.js";
import type { LlmFn } from "../core/types.js";

export interface LlmClassifierOptions {
  llm: LlmFn;
  model: string;
  questions: QuestionMap;
  maxTokens?: number;
}

/**
 * Answers a QuestionMap with a chat model.
 *
 * This exists so the classifier slot is filled before Jev arrives (M1), and so
 * the library can show the comparison the thesis rests on: same questions, same
 * answer shape, different decider — recorded in the trace as `by: "llm"`.
 *
 * The probabilities it returns are the model's self-report. They are NOT
 * calibrated and no threshold should be gated on them without measuring first.
 */
export class LlmClassifier implements Classifier {
  readonly name = "llm";
  readonly questions: QuestionMap;

  private readonly llm: LlmFn;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: LlmClassifierOptions) {
    this.llm = options.llm;
    this.model = options.model;
    this.questions = options.questions;
    this.maxTokens = options.maxTokens ?? 1024;
  }

  async classify(state: unknown): Promise<Answers> {
    const completion = await this.llm({
      model: this.model,
      system: SYSTEM,
      messages: [{ role: "user", content: renderPrompt(this.questions, state) }],
      tools: [],
      maxTokens: this.maxTokens,
    });

    const parsed = parseJsonObject(completion.text ?? "");
    return coerceAnswers(this.questions, parsed);
  }
}

const SYSTEM =
  "You answer bounded classification questions about a conversation. " +
  "Reply with a single JSON object and nothing else: no prose, no code fences.";

function renderPrompt(questions: QuestionMap, state: unknown): string {
  const lines: string[] = [
    "STATE:",
    typeof state === "string" ? state : JSON.stringify(state, null, 2),
    "",
    "QUESTIONS:",
  ];

  for (const [key, q] of Object.entries(questions)) {
    lines.push(`- "${key}" (${q.type}): ${q.instructions}`);
    if (q.type === "choice") {
      for (const [option, description] of Object.entries(q.criteria)) {
        lines.push(`    ${option}${description ? `: ${description}` : ""}`);
      }
    } else if (q.type === "score") {
      q.criteria.forEach((level, i) => lines.push(`    ${i}: ${level}`));
    } else if (q.criteria) {
      lines.push(`    true: ${q.criteria.true}`);
      lines.push(`    false: ${q.criteria.false}`);
    }
  }

  lines.push(
    "",
    "Answer with a JSON object keyed by question name. Shapes:",
    '  noul   -> {"type":"noul","noul":<0-1>,"confidence":<0-1>}',
    '  choice -> {"type":"choice","choice":"<option key>","confidence":<0-1>}',
    '  score  -> {"type":"score","score":<level index, may be fractional>,"confidence":<0-1>}',
    "Every question must appear exactly once. Use only the option keys listed.",
  );

  return lines.join("\n");
}

/** Models wrap JSON in prose or fences often enough that this has to be tolerant. */
function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    const value: unknown = JSON.parse(candidate.slice(start, end + 1));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Forces whatever came back into the declared shape. A missing or malformed
 * answer becomes a neutral one rather than an exception: a classifier that
 * throws takes the whole turn down, and the policies downstream already treat
 * low values as "do nothing".
 */
function coerceAnswers(questions: QuestionMap, raw: Record<string, unknown>): Answers {
  const answers: Answers = {};
  for (const [key, question] of Object.entries(questions)) {
    const value = raw[key];
    answers[key] = coerceAnswer(question, typeof value === "object" && value ? (value as Record<string, unknown>) : {});
  }
  return answers;
}

function coerceAnswer(question: Question, raw: Record<string, unknown>): Answer {
  const confidence = clamp01(raw["confidence"]);
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: clamp01(raw["noul"]), ...(confidence > 0 ? { confidence } : {}) };
    case "choice": {
      const options = Object.keys(question.criteria);
      const picked = typeof raw["choice"] === "string" ? raw["choice"] : "";
      return {
        type: "choice",
        choice: options.includes(picked) ? picked : (options[options.length - 1] ?? ""),
        ...(confidence > 0 ? { confidence } : {}),
      };
    }
    case "score": {
      const n = typeof raw["score"] === "number" && Number.isFinite(raw["score"]) ? raw["score"] : 0;
      const max = Math.max(0, question.criteria.length - 1);
      return {
        type: "score",
        score: Math.min(Math.max(n, 0), max),
        ...(confidence > 0 ? { confidence } : {}),
      };
    }
  }
}

function clamp01(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 1)
    : 0;
}
