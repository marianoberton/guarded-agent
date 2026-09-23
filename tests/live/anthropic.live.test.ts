import "dotenv/config";
import { describe, expect, it } from "vitest";
import { JevClassifier } from "../../src/classify/JevClassifier.js";
import { JevProvider } from "../../src/providers/jev.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { emptyConversation, runTurn } from "../../src/core/turn.js";
import { standardGuards } from "../../src/guards/index.js";
import { DEALERSHIP_QUESTIONS } from "../../examples/dealership/questions.js";
import {
  DEALERSHIP_TOOLS,
  lookupStock,
  SYSTEM_PROMPT,
} from "../../examples/dealership/tools.js";

/**
 * AnthropicProvider against the real Messages API. The translation is covered
 * offline in tests/providers/anthropic.test.ts; this is the part a unit test
 * cannot prove — that the API accepts the shape the translation produces.
 */

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const openrouterKey = process.env["OPENROUTER_API_KEY"];
const model = process.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5";

const live = anthropicKey ? describe : describe.skip;
const liveWithJev = anthropicKey && openrouterKey ? describe : describe.skip;

function provider(): AnthropicProvider {
  return new AnthropicProvider({ apiKey: anthropicKey as string });
}

live("AnthropicProvider against the live Messages API", () => {
  it("accepts parallel tool results grouped in one user message", async () => {
    // The grouping rule is the reason toAnthropicMessages exists. Hand-built so
    // the test does not depend on the model choosing to call in parallel.
    const completion = await provider().complete({
      model,
      system: SYSTEM_PROMPT,
      maxTokens: 512,
      tools: [lookupStock.spec],
      messages: [
        { role: "user", content: "¿Tienen Corolla 2022 y Hilux 2023?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "toolu_live_1", name: "lookupStock", args: { model: "Corolla", year: 2022 } },
            { id: "toolu_live_2", name: "lookupStock", args: { model: "Hilux", year: 2023 } },
          ],
        },
        { role: "tool", toolCallId: "toolu_live_1", content: "A-1 Corolla 2022 automatic, USD 18,500" },
        { role: "tool", toolCallId: "toolu_live_2", content: "No cars in stock match that search." },
      ],
    });

    expect(completion.stopReason).toBe("end");
    expect(completion.text).toMatch(/18\.?500|18,500/);
    expect(completion.usage.inputTokens).toBeGreaterThan(0);
  });
});

liveWithJev("a full turn with Anthropic as the responder", () => {
  it("looks the stock up instead of inventing it", async () => {
    const llm = provider();
    const jev = new JevProvider({
      apiKey: openrouterKey as string,
      ...(process.env["JEV_BASE_URL"] ? { baseUrl: process.env["JEV_BASE_URL"] } : {}),
      ...(process.env["JEV_MODEL"] ? { model: process.env["JEV_MODEL"] } : {}),
      appName: "guarded-agent/test",
    });
    const at = Date.now();

    const result = await runTurn(
      emptyConversation("live-anthropic"),
      { conversationId: "live-anthropic", text: "¿Tienen Corolla 2022 automático?", at },
      {
        llm: (req) => llm.complete(req),
        classifier: new JevClassifier({ jev, questions: DEALERSHIP_QUESTIONS }),
        guards: standardGuards({ rateLimit: { max: 10, windowMs: 60_000 } }),
        tools: DEALERSHIP_TOOLS,
        now: () => Date.now(),
        newId: () => "live",
        config: { system: SYSTEM_PROMPT, model, maxTokens: 1024, maxToolIterations: 5 },
      },
    );

    const steps = result.trace.map((entry) => entry.step);
    expect(steps).toContain("tool:lookupStock");

    const sent = result.actions.find((action) => action.type === "send");
    expect(sent?.type === "send" ? sent.text : "").toMatch(/18\.?500|18,500/);
  });
});
