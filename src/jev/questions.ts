import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "../classify/types.js";

/**
 * Question builders. These are plain data — the same objects go over the wire to
 * Jev and get rendered into a prompt by LlmClassifier, which is what makes the
 * two classifiers interchangeable.
 */

/** Is this statement true? Answered with a calibrated probability in [0,1]. */
export function noul(
  instructions: string,
  criteria?: { true: string; false: string },
): NoulQuestion {
  return { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
}

/** Pick one option. Pass descriptions as values; null when the key is enough. */
export function choice(
  instructions: string,
  criteria: Record<string, string | null>,
): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

/** Rate on an ordered rubric. `criteria` is lowest level first. */
export function score(instructions: string, criteria: string[]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}
