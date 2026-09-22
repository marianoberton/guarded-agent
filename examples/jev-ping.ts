import "dotenv/config";
import { JevProvider, jev } from "../src/index.js";

/**
 * Smallest possible check that Jev answers: one noul, one choice, one score.
 *
 *   npm run ping
 *
 * Prints the raw answers so you can see the probabilities, not just the picks.
 * Jev cannot return an invalid type — it can return a wrong valid one, which is
 * why the probability is the part worth looking at.
 */
async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const client = new JevProvider({
    apiKey,
    ...(process.env["JEV_BASE_URL"] ? { baseUrl: process.env["JEV_BASE_URL"] } : {}),
    ...(process.env["JEV_MODEL"] ? { model: process.env["JEV_MODEL"] } : {}),
    appName: "guarded-agent/ping",
  });

  const state = {
    history: [{ role: "assistant", text: "El Corolla 2022 automático sale USD 18.500." }],
    inbound: "¿Me lo dejás en 15?",
  };

  const startedAt = Date.now();
  const answers = await client.decide(state, {
    intent: jev.choice("What does the customer want?", {
      stock_question: "Availability, models, versions, colours.",
      price_negotiation: "Pushes for a discount or a lower price.",
      other: "None of these.",
    }),
    needs_human: jev.noul("Should a human take this conversation now?"),
    urgency: jev.score("How quickly does this need attention?", [
      "Not at all.",
      "Some time this week.",
      "Today or tomorrow.",
    ]),
  });
  const elapsed = Date.now() - startedAt;

  console.log(`\nstate: ${JSON.stringify(state.inbound)}`);
  console.log(`\n${JSON.stringify(answers, null, 2)}`);
  console.log(
    `\n${elapsed}ms  ${client.usage.inputTokens} input tokens  $${client.costUsd().toFixed(6)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
