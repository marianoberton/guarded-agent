import "dotenv/config";
import { describe, expect, it } from "vitest";
import { JevClassifier } from "../../src/classify/JevClassifier.js";
import { JevProvider } from "../../src/providers/jev.js";
import { OpenRouterProvider } from "../../src/providers/openrouter.js";
import { emptyConversation, runTurn } from "../../src/core/turn.js";
import { readChoice, readNoul } from "../../src/classify/types.js";
import { standardGuards } from "../../src/guards/index.js";
import { DEALERSHIP_QUESTIONS } from "../../examples/dealership/questions.js";
import { DEALERSHIP_TOOLS, SYSTEM_PROMPT } from "../../examples/dealership/tools.js";

/**
 * Live smoke tests: real network, real money. Excluded from `npm test`; run
 * with `npm run test:live` when closing a milestone.
 */

const apiKey = process.env["OPENROUTER_API_KEY"];
const live = apiKey ? describe : describe.skip;

function jevProvider(): JevProvider {
  return new JevProvider({
    apiKey: apiKey as string,
    ...(process.env["JEV_BASE_URL"] ? { baseUrl: process.env["JEV_BASE_URL"] } : {}),
    ...(process.env["JEV_MODEL"] ? { model: process.env["JEV_MODEL"] } : {}),
    appName: "guarded-agent/test",
  });
}

live("Jev against the live decisions endpoint", () => {
  it("answers a choice and a noul with probabilities", async () => {
    const answers = await new JevClassifier({
      jev: jevProvider(),
      questions: DEALERSHIP_QUESTIONS,
    }).classify({
      history: [{ role: "assistant", text: "El Corolla 2022 automático sale USD 18.500." }],
      inbound: "¿Me lo dejás en 15?",
    });

    // The point of Jev is that a threshold on this is meaningful, so the
    // probability has to actually come back.
    expect(readChoice(answers, "intent").choice).toBe("price_negotiation");
    expect(readChoice(answers, "intent").confidence).toBeGreaterThan(0);
    expect(readNoul(answers, "needs_human")).toBeGreaterThanOrEqual(0);
    expect(readChoice(answers, "language").choice).toBe("es");
  });

  it("costs what the spec claims it costs", async () => {
    const jev = jevProvider();
    await jev.decide({ inbound: "hola" }, DEALERSHIP_QUESTIONS);

    expect(jev.usage.requests).toBe(1);
    expect(jev.usage.inputTokens).toBeGreaterThan(0);
    // Fractions of a cent per decision, or the architecture's premise is wrong.
    expect(jev.costUsd()).toBeLessThan(0.001);
  });
});

live("a full turn against OpenRouter", () => {
  it("looks the stock up instead of inventing it", async () => {
    const provider = new OpenRouterProvider({
      apiKey: apiKey as string,
      appName: "guarded-agent/test",
    });
    const model = process.env["RESPONDER_MODEL"] ?? "google/gemini-2.5-flash-lite";
    const at = Date.now();

    const result = await runTurn(
      emptyConversation("live-1"),
      { conversationId: "live-1", text: "¿Tienen Corolla 2022 automático?", at },
      {
        llm: (req) => provider.complete(req),
        classifier: new JevClassifier({ jev: jevProvider(), questions: DEALERSHIP_QUESTIONS }),
        guards: standardGuards({ rateLimit: { max: 10, windowMs: 60_000 } }),
        tools: DEALERSHIP_TOOLS,
        now: () => Date.now(),
        newId: () => "live",
        config: { system: SYSTEM_PROMPT, model, maxTokens: 1024, maxToolIterations: 5 },
      },
    );

    const steps = result.trace.map((entry) => entry.step);
    expect(steps).toContain("preCheck");
    expect(steps).toContain("classify");
    // A reply written without checking stock is invented, however fluent.
    expect(steps).toContain("tool:lookupStock");

    expect(result.actions.some((action) => action.type === "send")).toBe(true);
    expect(result.trace.find((entry) => entry.step === "classify")?.by).toBe("jev");

    const sent = result.actions.find((action) => action.type === "send");
    // A-1 is the only 2022 automatic Corolla in the invented stock.
    expect(sent?.type === "send" ? sent.text : "").toMatch(/18\.?500|18,500/);
  });
});
