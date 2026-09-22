import type { Answer, Answers, Classifier, Question, QuestionMap } from "./types.js";
import type { JevProvider } from "../providers/jev.js";

export interface JevClassifierOptions {
  jev: JevProvider;
  questions: QuestionMap;
}

/**
 * Bounded decisions answered by Jev: typed, calibrated, ~100ms, near-zero cost.
 *
 * Interchangeable with LlmClassifier by construction — same interface, same
 * question map, same answer shape. Swapping them is a one-line change in the
 * agent config, and the trace records which one decided.
 *
 * Jev cannot return an invalid type. It CAN return a wrong valid one. The
 * thresholds are the caller's to choose, and the honest way to choose them is
 * to measure against labelled outcomes (agent-evals calibrate) rather than to
 * guess.
 */
export class JevClassifier implements Classifier {
  readonly name = "jev";
  readonly questions: QuestionMap;

  private readonly jev: JevProvider;

  constructor(options: JevClassifierOptions) {
    this.jev = options.jev;
    this.questions = options.questions;
  }

  async classify(state: unknown): Promise<Answers> {
    const raw = await this.jev.decide(state, this.questions);
    return normalize(this.questions, raw);
  }
}

/**
 * Fills in the `type` tag and drops answers for questions that were not asked.
 *
 * The endpoint echoes the type, but reading it back off the wire rather than
 * from the question we sent would let a malformed response silently change what
 * a policy thinks it is thresholding on.
 */
function normalize(questions: QuestionMap, raw: Answers): Answers {
  const answers: Answers = {};

  for (const [key, question] of Object.entries(questions)) {
    const value = raw[key];
    if (value) answers[key] = { ...value, type: question.type } as Answer;
  }

  return answers;
}

/** Convenience for reading a single noul without building a classifier. */
export async function askNoul(
  jev: JevProvider,
  state: unknown,
  key: string,
  question: Question,
): Promise<Answers> {
  return jev.decide(state, { [key]: question });
}
