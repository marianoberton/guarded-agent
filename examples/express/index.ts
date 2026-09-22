import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pg from "pg";
import {
  createWorker,
  explain,
  JevClassifier,
  JevProvider,
  jev,
  OpenRouterProvider,
  policies,
  PostgresStore,
  standardGuards,
  WhatsAppChannel,
} from "../../src/index.js";
import { DEALERSHIP_QUESTIONS } from "../dealership/questions.js";
import { DEALERSHIP_TOOLS, sendQuote, SYSTEM_PROMPT } from "../dealership/tools.js";

/**
 * Turn-per-job, end to end.
 *
 * The webhook persists and enqueues. It never calls a model — a webhook that
 * waits for an LLM is a webhook that times out, and Meta will retry it while
 * you are still thinking.
 *
 *   npm run db:up
 *   npm run example:express
 *   curl -X POST localhost:3000/webhook -H 'content-type: application/json' \
 *        -d '{"from":"5491100000000","text":"¿tienen Corolla 2022 automático?"}'
 *   curl localhost:3000/explain/<turnId>
 */

const DEBOUNCE_MS = 30_000;

async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString:
      process.env["DATABASE_URL"] ?? "postgres://guarded:guarded@localhost:54329/guarded_agent",
  });
  const store = new PostgresStore(pool);
  await store.migrate();

  const provider = new OpenRouterProvider({ apiKey, appName: "guarded-agent/express" });
  const model = process.env["RESPONDER_MODEL"] ?? "google/gemini-2.5-flash-lite";
  const jevClient = new JevProvider({ apiKey, appName: "guarded-agent/express" });

  const worker = createWorker({
    store,
    concurrency: Number(process.env["WORKER_CONCURRENCY"] ?? 4),
    debounceMs: DEBOUNCE_MS,
    deps: () => ({
      llm: (req) => provider.complete(req),
      classifier: new JevClassifier({ jev: jevClient, questions: DEALERSHIP_QUESTIONS }),
      guards: standardGuards({
        killSwitch: () => process.env["AGENT_ENABLED"] !== "false",
        debounceMs: DEBOUNCE_MS,
        rateLimit: { max: 10, windowMs: 60_000 },
      }),
      policies: [
        policies.escalateWhen({ intent: "price_negotiation" }),
        policies.escalateWhen({ intent: "asks_for_human" }),
        policies.escalateWhen({ noul: "needs_human", above: 0.85 }),
        policies.veto({ tool: sendQuote, when: (c) => c.args.discountPct > 10 }),
        policies.riskGate({
          jev: jevClient,
          question: jev.noul(
            "Is this action something the business would not want done automatically?",
          ),
          blockAbove: 0.8,
          escalateAbove: 0.5,
        }),
        policies.maxTurnsWithoutProgress(4),
        policies.notContains(["descuento", "discount"]),
      ],
      channel: new WhatsAppChannel({ windowHours: 24, templates: { reopen: "hello_again" } }),
      tools: DEALERSHIP_TOOLS,
      now: () => Date.now(),
      newId: () => randomUUID(),
      config: { system: SYSTEM_PROMPT, model, maxTokens: 1024, maxToolIterations: 5 },
    }),
    // The only place that touches a real transport. Swap this for the Meta
    // Cloud API call; guarded-agent deliberately ships no client for it.
    deliver: (action, { state }) => {
      switch (action.type) {
        case "send":
          console.log(`-> [${state.id}] ${action.text}`);
          break;
        case "sendTemplate":
          console.log(`-> [${state.id}] template ${action.template} (${action.reason})`);
          console.log(`   not sent: ${action.pendingText}`);
          break;
        case "setStatus":
          console.log(`   [${state.id}] status -> ${action.status}: ${action.reason}`);
          break;
      }
    },
    onError: (error, job) => console.error(`job ${job.conversationId} failed:`, error),
  });

  const server = createServer((req, res) => {
    void route(req, res, store).catch((error: unknown) => {
      console.error(error);
      send(res, 500, { error: "internal" });
    });
  });

  const port = Number(process.env["PORT"] ?? 3000);
  server.listen(port, () => console.log(`webhook on http://localhost:${port}`));

  void worker.start();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      worker.stop();
      server.close();
      void pool.end().then(() => process.exit(0));
    });
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: PostgresStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/webhook") {
    const body = (await readJson(req)) as { from?: string; text?: string };
    if (!body.from || !body.text) return send(res, 400, { error: "from and text are required" });

    // Persist and enqueue, then answer immediately. No model call on this path.
    await store.enqueue(
      { conversationId: body.from, text: body.text, at: Date.now() },
      { now: Date.now(), debounceMs: DEBOUNCE_MS },
    );
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname.startsWith("/explain/")) {
    const turn = await store.getTurn(url.pathname.slice("/explain/".length));
    if (!turn) return send(res, 404, { error: "no such turn" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(explain(turn));
    return;
  }

  send(res, 404, { error: "not found" });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
