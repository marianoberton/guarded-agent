import { describe, expect, it } from "vitest";
import { LlmClassifier } from "../../src/classify/LlmClassifier.js";
import { readChoice, readNoul, readScore } from "../../src/classify/types.js";
import type { QuestionMap } from "../../src/classify/types.js";
import { choice, noul, score } from "../../src/jev/questions.js";
import { completion, stubLlm } from "../helpers.js";

const questions: QuestionMap = {
  intent: choice("What does the customer want?", {
    stock_question: "Availability, models, versions",
    price_negotiation: "Pushes for a discount",
    other: "None of these",
  }),
  needs_human: noul("Should a human take this conversation now?"),
  urgency: score("How urgent is this?", ["Not at all", "Somewhat", "Very"]),
};

function classifierWith(text: string): {
  classifier: LlmClassifier;
  llm: ReturnType<typeof stubLlm>;
} {
  const llm = stubLlm([completion({ text })]);
  return {
    llm,
    classifier: new LlmClassifier({ llm: llm.fn, model: "test/model", questions }),
  };
}

describe("LlmClassifier", () => {
  it("answers every question in one request", async () => {
    const { classifier, llm } = classifierWith(
      JSON.stringify({
        intent: { type: "choice", choice: "stock_question", confidence: 0.9 },
        needs_human: { type: "noul", noul: 0.1 },
        urgency: { type: "score", score: 1.5, confidence: 0.6 },
      }),
    );

    const answers = await classifier.classify({ inbound: "do you have a Corolla?" });

    expect(llm.requests).toHaveLength(1);
    expect(readChoice(answers, "intent")).toEqual({ choice: "stock_question", confidence: 0.9 });
    expect(readNoul(answers, "needs_human")).toBe(0.1);
    expect(readScore(answers, "urgency")).toEqual({ score: 1.5, confidence: 0.6 });
  });

  it("renders the option keys and level descriptions into the prompt", () => {
    const { classifier, llm } = classifierWith("{}");
    return classifier.classify({ inbound: "hi" }).then(() => {
      const prompt = llm.requests[0]?.messages[0];
      const text = prompt && "content" in prompt ? String(prompt.content) : "";
      expect(text).toContain("stock_question: Availability, models, versions");
      expect(text).toContain("2: Very");
      // No tools: classification is a bounded fork, not an agentic loop.
      expect(llm.requests[0]?.tools).toEqual([]);
    });
  });

  it("recovers an answer wrapped in a code fence", async () => {
    const { classifier } = classifierWith(
      'Here you go:\n```json\n{"needs_human":{"type":"noul","noul":0.8}}\n```',
    );

    const answers = await classifier.classify({});
    expect(readNoul(answers, "needs_human")).toBe(0.8);
  });

  it("falls back to a neutral answer rather than throwing on garbage", async () => {
    // A classifier that throws takes the whole turn down. The policies
    // downstream already treat low values as "do nothing", so neutral is safe.
    const { classifier } = classifierWith("I cannot help with that.");
    const answers = await classifier.classify({});

    expect(readNoul(answers, "needs_human")).toBe(0);
    expect(readScore(answers, "urgency").score).toBe(0);
    expect(Object.keys(answers).sort()).toEqual(["intent", "needs_human", "urgency"]);
  });

  it("refuses an option the question never offered", async () => {
    const { classifier } = classifierWith(
      JSON.stringify({ intent: { type: "choice", choice: "invented_option" } }),
    );

    const answers = await classifier.classify({});
    // Falls back to the last declared option, which is the catch-all by convention.
    expect(readChoice(answers, "intent").choice).toBe("other");
  });

  it("clamps out-of-range values", async () => {
    const { classifier } = classifierWith(
      JSON.stringify({
        needs_human: { type: "noul", noul: 7 },
        urgency: { type: "score", score: 99 },
      }),
    );

    const answers = await classifier.classify({});
    expect(readNoul(answers, "needs_human")).toBe(1);
    // Three levels means the top index is 2.
    expect(readScore(answers, "urgency").score).toBe(2);
  });
});
