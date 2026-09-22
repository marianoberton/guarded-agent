import "dotenv/config";
import { randomUUID } from "node:crypto";
import { emptyConversation, MemoryStore, OpenRouterProvider, runTurn } from "../../src/index.js";
import { DEALERSHIP_TOOLS, SYSTEM_PROMPT } from "./tools.js";

/**
 * M0 smoke: a stock question, answered through a tool call, against OpenRouter.
 * No guards, no classifier, no policies yet — those arrive in M1 and M2.
 */
async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const provider = new OpenRouterProvider({ apiKey, appName: "guarded-agent/dealership" });
  const store = new MemoryStore();

  const conversationId = "demo-1";
  const state = (await store.load(conversationId)) ?? emptyConversation(conversationId);
  const question = process.argv.slice(2).join(" ") || "¿Tienen Corolla 2022 automático?";

  const result = await runTurn(
    state,
    { conversationId, text: question, at: Date.now() },
    {
      llm: (req) => provider.complete(req),
      tools: DEALERSHIP_TOOLS,
      now: () => Date.now(),
      newId: () => randomUUID(),
      config: {
        system: SYSTEM_PROMPT,
        model: process.env["RESPONDER_MODEL"] ?? "google/gemini-2.5-flash-lite",
        maxTokens: 1024,
        maxToolIterations: 5,
      },
    },
  );

  await store.save(result.state);
  await store.recordTurn({
    id: randomUUID(),
    conversationId,
    at: Date.now(),
    inbound: question,
    actions: result.actions,
    trace: result.trace,
  });

  console.log(`\n> ${question}\n`);
  for (const action of result.actions) {
    if (action.type === "send") console.log(action.text);
    else console.log(`[${action.type}: ${action.status} — ${action.reason}]`);
  }

  console.log("\n--- trace ---");
  for (const entry of result.trace) {
    const cost = entry.costUsd !== undefined ? `  $${entry.costUsd.toFixed(6)}` : "";
    const tokens = entry.usage ? `  ${entry.usage.inputTokens}in/${entry.usage.outputTokens}out` : "";
    console.log(`${entry.by.padEnd(4)}  ${entry.step.padEnd(22)} ${entry.outcome.padEnd(18)} ${String(entry.latencyMs).padStart(6)}ms${tokens}${cost}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
