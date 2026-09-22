import { afterEach, describe, expect, it, vi } from "vitest";
import { JevClassifier } from "../../src/classify/JevClassifier.js";
import { JevProvider } from "../../src/providers/jev.js";
import { readChoice, readNoul, readScore } from "../../src/classify/types.js";
import { choice, noul, score } from "../../src/jev/questions.js";
import type { QuestionMap } from "../../src/classify/types.js";

const questions: QuestionMap = {
  intent: choice("What does the customer want?", {
    stock_question: "Availability",
    price_negotiation: "Pushes for a discount",
    other: null,
  }),
  needs_human: noul("Should a human take this now?"),
  urgency: score("How urgent?", ["None", "Some", "High"]),
};

function stubDecisions(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function classifier(): JevClassifier {
  return new JevClassifier({
    jev: new JevProvider({ apiKey: "k", maxRps: 0 }),
    questions,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JevClassifier", () => {
  it("answers every question in one request, not one per question", async () => {
    // Jev evaluates each question in parallel against the same state, so a
    // second request buys nothing and costs a full state's worth of tokens.
    const fetchMock = stubDecisions({
      answers: {
        intent: { type: "choice", choice: "price_negotiation", confidence: 0.91 },
        needs_human: { type: "noul", noul: 0.64 },
        urgency: { type: "score", score: 1.8, confidence: 0.7 },
      },
      usage: { input_tokens: 1400, output_tokens: 0 },
    });

    const answers = await classifier().classify({ inbound: "me lo dejás en 15?" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readChoice(answers, "intent")).toEqual({
      choice: "price_negotiation",
      confidence: 0.91,
    });
    expect(readNoul(answers, "needs_human")).toBe(0.64);
    expect(readScore(answers, "urgency")).toEqual({ score: 1.8, confidence: 0.7 });
  });

  it("tags answers from the question we asked, not from the echoed type", async () => {
    // A malformed echo must not be able to change what a policy thinks it is
    // thresholding on.
    stubDecisions({
      answers: { needs_human: { type: "choice", noul: 0.8 } },
    });

    const answers = await classifier().classify({});
    expect(answers["needs_human"]?.type).toBe("noul");
  });

  it("drops answers for questions that were never asked", async () => {
    stubDecisions({
      answers: {
        needs_human: { type: "noul", noul: 0.2 },
        invented: { type: "noul", noul: 0.99 },
      },
    });

    const answers = await classifier().classify({});
    expect(Object.keys(answers)).toEqual(["needs_human"]);
  });

  it("identifies itself as jev so the trace records who decided", async () => {
    expect(classifier().name).toBe("jev");
  });
});
