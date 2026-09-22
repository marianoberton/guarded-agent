import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyConversation, runTurn } from "../../src/core/turn.js";
import { JevClassifier } from "../../src/classify/JevClassifier.js";
import { LlmClassifier } from "../../src/classify/LlmClassifier.js";
import { JevProvider } from "../../src/providers/jev.js";
import { choice, noul } from "../../src/jev/questions.js";
import type { Classifier, QuestionMap } from "../../src/classify/types.js";
import type { Inbound } from "../../src/core/types.js";
import { completion, deps, stubLlm } from "../helpers.js";

/**
 * The spec promises that swapping JevClassifier for LlmClassifier is a one-line
 * change. That is a claim about the interface, so it gets a test rather than a
 * sentence in the README.
 */

const questions: QuestionMap = {
  intent: choice("What does the customer want?", {
    stock_question: "Availability",
    price_negotiation: "Pushes for a discount",
    other: null,
  }),
  needs_human: noul("Should a human take this now?"),
};

const inbound: Inbound = { conversationId: "c1", text: "¿me lo dejás en 15?", at: 1_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function jevClassifier(): Classifier {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              intent: { type: "choice", choice: "price_negotiation", confidence: 0.91 },
              needs_human: { type: "noul", noul: 0.64 },
            },
            usage: { input_tokens: 1400, output_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
  return new JevClassifier({ jev: new JevProvider({ apiKey: "k", maxRps: 0 }), questions });
}

function llmClassifier(): Classifier {
  const llm = stubLlm([
    completion({
      text: JSON.stringify({
        intent: { type: "choice", choice: "price_negotiation", confidence: 0.55 },
        needs_human: { type: "noul", noul: 0.4 },
      }),
    }),
  ]);
  return new LlmClassifier({ llm: llm.fn, model: "test/model", questions });
}

async function turnWith(classifier: Classifier): ReturnType<typeof runTurn> {
  return runTurn(
    emptyConversation("c1"),
    inbound,
    deps({
      llm: stubLlm([completion({ text: "Dejame consultarlo." })]).fn,
      tools: [],
      classifier,
    }),
  );
}

describe("classifier interchangeability", () => {
  it("accepts either classifier in the same slot with no other change", async () => {
    const withJev = await turnWith(jevClassifier());
    const withLlm = await turnWith(llmClassifier());

    for (const result of [withJev, withLlm]) {
      expect(result.actions).toEqual([{ type: "send", text: "Dejame consultarlo." }]);
      expect(result.trace.map((entry) => entry.step)).toEqual([
        "preCheck",
        "classify",
        "respond",
        "send",
      ]);
    }
  });

  it("records which of the three colours decided", async () => {
    // The comparison is a first-class feature, so the trace has to distinguish
    // them — otherwise you cannot tell a calibrated answer from a guess.
    const withJev = await turnWith(jevClassifier());
    const withLlm = await turnWith(llmClassifier());

    expect(withJev.trace.find((e) => e.step === "classify")?.by).toBe("jev");
    expect(withLlm.trace.find((e) => e.step === "classify")?.by).toBe("llm");
  });

  it("produces the same answer keys and shapes from both", async () => {
    const jevAnswers = (await turnWith(jevClassifier())).trace.find((e) => e.step === "classify")
      ?.detail?.["answers"] as Record<string, { type: string }>;
    const llmAnswers = (await turnWith(llmClassifier())).trace.find((e) => e.step === "classify")
      ?.detail?.["answers"] as Record<string, { type: string }>;

    expect(Object.keys(jevAnswers).sort()).toEqual(Object.keys(llmAnswers).sort());
    expect(jevAnswers["intent"]?.type).toBe(llmAnswers["intent"]?.type);
    expect(jevAnswers["needs_human"]?.type).toBe(llmAnswers["needs_human"]?.type);
  });
});
