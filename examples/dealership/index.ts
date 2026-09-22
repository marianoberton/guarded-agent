import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  emptyConversation,
  explain,
  JevClassifier,
  JevProvider,
  LlmClassifier,
  jev,
  MemoryStore,
  OpenRouterProvider,
  policies,
  runTurn,
  standardGuards,
} from "../../src/index.js";
import type { Classifier } from "../../src/index.js";
import { DEALERSHIP_QUESTIONS } from "./questions.js";
import { DEALERSHIP_TOOLS, sendQuote, SYSTEM_PROMPT } from "./tools.js";

/**
 * The three colours in one turn.
 *
 *   code  decides the gates      — kill switch, pause, takeover, debounce
 *   jev   decides bounded forks  — intent, language, needs_human
 *   llm   writes                 — the reply and the tool arguments
 *
 *   npm run example
 *   npm run example -- "¿Me lo dejás en 15?"
 *   CLASSIFIER=llm npm run example       # the same turn, decided by a chat model
 */
async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const provider = new OpenRouterProvider({ apiKey, appName: "guarded-agent/dealership" });
  const model = process.env["RESPONDER_MODEL"] ?? "google/gemini-2.5-flash-lite";
  const store = new MemoryStore();

  const jevClient = new JevProvider({
    apiKey,
    ...(process.env["JEV_BASE_URL"] ? { baseUrl: process.env["JEV_BASE_URL"] } : {}),
    ...(process.env["JEV_MODEL"] ? { model: process.env["JEV_MODEL"] } : {}),
    zdr: process.env["JEV_ZDR"] !== "false",
    appName: "guarded-agent/dealership",
  });

  // The one-line swap the spec promises. Both sides answer the same question
  // map and return the same shapes; only the decider changes, and the trace
  // records which one it was.
  const classifier: Classifier =
    process.env["CLASSIFIER"] === "llm"
      ? new LlmClassifier({
          llm: (req) => provider.complete(req),
          model,
          questions: DEALERSHIP_QUESTIONS,
        })
      : new JevClassifier({ jev: jevClient, questions: DEALERSHIP_QUESTIONS });

  const conversationId = "demo-1";
  const state = (await store.load(conversationId)) ?? emptyConversation(conversationId);
  const question = process.argv.slice(2).join(" ") || "¿Tienen Corolla 2022 automático?";
  const at = Date.now();

  const result = await runTurn(
    state,
    { conversationId, text: question, at },
    {
      llm: (req) => provider.complete(req),
      classifier,
      guards: standardGuards({
        killSwitch: () => process.env["AGENT_ENABLED"] !== "false",
        // Debounce is off here so a one-shot example is not skipped for being
        // too fresh. A deployment wants it on — see the express example (M4).
        rateLimit: { max: 10, windowMs: 60_000 },
      }),
      policies: [
        // Cheapest first: a choice already computed this turn costs nothing to
        // read, while riskGate costs a request. No point paying for a risk
        // score on a conversation that was going to a person anyway.
        policies.escalateWhen({ intent: "price_negotiation" }),
        policies.escalateWhen({ intent: "asks_for_human" }),
        policies.escalateWhen({ noul: "needs_human", above: 0.85 }),
        policies.veto({
          tool: sendQuote,
          when: (c) => c.args.discountPct > 10,
          reason: "discount_over_10",
        }),
        policies.riskGate({
          jev: jevClient,
          question: jev.noul(
            "Is this action something the business would not want done automatically?",
          ),
          blockAbove: 0.8,
          escalateAbove: 0.5,
        }),
        policies.maxTurnsWithoutProgress(4),
        // Last line of defence: a model that writes "descuento" has made a
        // promise regardless of what the prompt said.
        policies.notContains(["descuento", "discount"]),
      ],
      tools: DEALERSHIP_TOOLS,
      now: () => Date.now(),
      newId: () => randomUUID(),
      config: { system: SYSTEM_PROMPT, model, maxTokens: 1024, maxToolIterations: 5 },
    },
  );

  const turnId = randomUUID();
  await store.save(result.state);
  await store.recordTurn({
    id: turnId,
    conversationId,
    at,
    inbound: question,
    actions: result.actions,
    trace: result.trace,
  });

  console.log(`\n> ${question}\n`);
  for (const action of result.actions) {
    switch (action.type) {
      case "send":
        console.log(action.text);
        break;
      case "sendTemplate":
        console.log(`[window shut (${action.reason}) -> template "${action.template}"]`);
        console.log(`[not sent: ${action.pendingText}]`);
        break;
      case "setStatus":
        console.log(`[status -> ${action.status}: ${action.reason}]`);
        break;
    }
  }

  console.log(`\n--- explain(${turnId.slice(0, 8)}) ---`);
  console.log(
    explain({
      id: turnId,
      conversationId,
      at,
      inbound: question,
      actions: result.actions,
      trace: result.trace,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
