/**
 * The classifier boundary.
 *
 * Question and answer shapes mirror Jev's wire format exactly, so JevClassifier
 * is a pass-through and LlmClassifier is the one doing translation work — not
 * the other way round. Swapping between them must be a one-line change.
 */

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  /** Optional worked definitions of what true and false look like. */
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option key -> description (null when the key speaks for itself). */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered level descriptions, lowest first. The score indexes into these. */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type QuestionMap = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** Calibrated probability that the statement is true. */
  noul: number;
  confidence?: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted average over the criteria levels. */
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, Answer>;

export interface Classifier {
  readonly name: string;
  readonly questions: QuestionMap;
  /** One call answers every question. Never one request per question. */
  classify(state: unknown): Promise<Answers>;
}

// --- Typed readers -----------------------------------------------------------
// Answers come off the wire; read them defensively rather than trusting shape.

export function readNoul(answers: Answers, key: string, fallback = 0): number {
  const a = answers[key];
  return a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul : fallback;
}

export function readChoice(
  answers: Answers,
  key: string,
  fallback = "other",
): { choice: string; confidence: number } {
  const a = answers[key];
  if (!a || a.type !== "choice") return { choice: fallback, confidence: 0 };
  const confidence = Number.isFinite(a.confidence)
    ? (a.confidence as number)
    : (a.probabilities?.[a.choice] ?? 0);
  return { choice: a.choice || fallback, confidence };
}

export function readScore(
  answers: Answers,
  key: string,
  fallback = 0,
): { score: number; confidence: number } {
  const a = answers[key];
  if (!a || a.type !== "score") return { score: fallback, confidence: 0 };
  return {
    score: Number.isFinite(a.score) ? a.score : fallback,
    confidence: Number.isFinite(a.confidence) ? (a.confidence as number) : 0,
  };
}
