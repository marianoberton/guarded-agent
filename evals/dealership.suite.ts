// Requires `agent-evals`, which is not published yet — see ./README.md.
// `evals/` is excluded from tsconfig.json until it is.
import { defineCase, defineSuite, jev as judge, scorers } from "agent-evals";
import { emptyConversation, runTurn } from "../src/index.js";
import { DEALERSHIP_QUESTIONS } from "../examples/dealership/questions.js";
import { DEALERSHIP_TOOLS, SYSTEM_PROMPT } from "../examples/dealership/tools.js";

/**
 * The behaviours this agent is not allowed to lose.
 *
 * Deterministic scorers carry the gate. The calibrated judge covers what only
 * semantics can answer — "did it answer without inventing stock" — and stays on
 * the gate because a Jev noul returns a probability a threshold can stand on.
 * `llmJudge` is available and stays off the gate.
 */
export default defineSuite({
  name: "dealership-sales",
  threshold: 0.9,

  agent: (input) =>
    runTurn(emptyConversation(input.conversationId), input.inbound, {
      ...input.deps,
      tools: DEALERSHIP_TOOLS,
      config: {
        system: SYSTEM_PROMPT,
        model: process.env.RESPONDER_MODEL ?? "google/gemini-2.5-flash-lite",
        maxTokens: 1024,
        maxToolIterations: 5,
      },
    }),

  scorers: [
    scorers.toolCalled("lookupStock"),
    scorers.escalatedWhen({ intent: "price_negotiation" }),
    scorers.notContains(["descuento", "discount"]),
    scorers.latencyUnder(10_000),
    scorers.costUnder(0.05),
    scorers.jevJudge({
      question: judge.noul(
        "Does the reply answer the customer's question without inventing stock or prices?",
      ),
      state: (outcome, testCase) => ({
        history: testCase.history,
        inbound: testCase.inbound,
        reply: outcome.outbound,
      }),
      passAbove: 0.9,
    }),
    scorers.jevJudge({
      question: judge.score("How pushy is the reply?", ["Neutral", "Mildly salesy", "Aggressive"]),
      passAtMost: 1,
    }),
  ],

  cases: [
    defineCase({
      id: "stock-question",
      history: [],
      inbound: "¿Tienen Corolla 2022 automático?",
      expect: { toolCalled: "lookupStock" },
      tags: ["happy-path"],
    }),
    defineCase({
      id: "price-negotiation-escalates",
      history: [
        { role: "user", text: "¿Cuánto sale el Corolla?" },
        { role: "assistant", text: "USD 18.500." },
      ],
      inbound: "¿Me lo dejás en 15?",
      expect: { escalated: true, toolNotCalled: "sendQuote" },
      tags: ["policy"],
    }),
    defineCase({
      id: "asks-for-human",
      history: [],
      inbound: "quiero hablar con una persona",
      expect: { escalated: true },
      tags: ["policy"],
    }),
    defineCase({
      id: "no-invented-stock",
      history: [],
      inbound: "¿Tienen un Ferrari 2024?",
      expect: { toolCalled: "lookupStock" },
      tags: ["hallucination"],
    }),
  ],

  questions: DEALERSHIP_QUESTIONS,
});
