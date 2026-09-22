import "dotenv/config";
import { emptyConversation, OpenRouterProvider, runTurn } from "../../src/index.js";
import type { TraceEntry } from "../../src/index.js";
import { DEALERSHIP_TOOLS, SYSTEM_PROMPT } from "./tools.js";

/**
 * Runs the same turn against several models and reports what each one cost,
 * how long it took and whether it actually used the tools.
 *
 * The library is model-agnostic by construction — RESPONDER_MODEL is a string —
 * so the only honest way to pick one is to measure. Price per token is the easy
 * half; the half that matters is whether the model looks the stock up instead of
 * inventing it.
 *
 *   npm run compare
 *   npm run compare -- "¿Me lo dejás en 15?"
 *   npm run compare -- --models openai/gpt-5-nano,google/gemini-2.5-flash-lite
 */

const DEFAULT_MODELS = [
  "google/gemini-2.5-flash-lite",
  "openai/gpt-5-nano",
  "qwen/qwen3-30b-a3b-instruct-2507",
  "anthropic/claude-haiku-4.5",
];

const DEFAULT_QUESTION = "¿Tienen Corolla 2022 automático?";

interface Row {
  model: string;
  toolsCalled: string[];
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  reply: string;
  error?: string;
}

async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const { models, question } = parseArgs(process.argv.slice(2));
  const provider = new OpenRouterProvider({ apiKey, appName: "guarded-agent/compare" });

  console.log(`\nQuestion: ${question}`);
  console.log(`Models:   ${models.length}\n`);

  const rows: Row[] = [];
  for (const model of models) {
    process.stdout.write(`  running ${model} ... `);
    const row = await runOne(provider, model, question);
    rows.push(row);
    console.log(row.error ? "failed" : `${row.wallMs}ms`);
  }

  printTable(rows);
  printReplies(rows);
  printVerdict(rows);
}

async function runOne(
  provider: OpenRouterProvider,
  model: string,
  question: string,
): Promise<Row> {
  const startedAt = Date.now();
  const base: Row = {
    model,
    toolsCalled: [],
    wallMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    reply: "",
  };

  try {
    const result = await runTurn(
      emptyConversation("compare"),
      { conversationId: "compare", text: question, at: Date.now() },
      {
        llm: (req) => provider.complete(req),
        tools: DEALERSHIP_TOOLS,
        now: () => Date.now(),
        newId: () => "compare",
        config: {
          system: SYSTEM_PROMPT,
          model,
          maxTokens: 1024,
          maxToolIterations: 5,
        },
      },
    );

    const sent = result.actions.find((action) => action.type === "send");
    return {
      ...base,
      ...totals(result.trace),
      wallMs: Date.now() - startedAt,
      toolsCalled: result.trace
        .filter((entry) => entry.step.startsWith("tool:"))
        .map((entry) => entry.step.slice(5)),
      reply: sent?.type === "send" ? sent.text : "(no reply sent)",
    };
  } catch (error) {
    return {
      ...base,
      wallMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function totals(trace: readonly TraceEntry[]): Pick<
  Row,
  "inputTokens" | "outputTokens" | "costUsd"
> {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;

  for (const entry of trace) {
    if (entry.usage) {
      inputTokens += entry.usage.inputTokens;
      outputTokens += entry.usage.outputTokens;
    }
    if (entry.costUsd !== undefined) costUsd = (costUsd ?? 0) + entry.costUsd;
  }

  return { inputTokens, outputTokens, costUsd };
}

function printTable(rows: readonly Row[]): void {
  const width = Math.max(...rows.map((row) => row.model.length), 5);
  console.log(
    `\n${"model".padEnd(width)}  ${"tools".padEnd(22)} ${"latency".padStart(9)} ${"tokens".padStart(12)} ${"cost".padStart(11)} ${"per 1k turns".padStart(13)}`,
  );
  console.log("-".repeat(width + 74));

  for (const row of rows) {
    if (row.error) {
      console.log(`${row.model.padEnd(width)}  ${`FAILED: ${row.error}`.slice(0, 60)}`);
      continue;
    }
    const cost = row.costUsd === null ? "n/a" : `$${row.costUsd.toFixed(6)}`;
    const per1k = row.costUsd === null ? "n/a" : `$${(row.costUsd * 1000).toFixed(2)}`;
    console.log(
      `${row.model.padEnd(width)}  ${(row.toolsCalled.join(",") || "(none)").padEnd(22)} ${`${row.wallMs}ms`.padStart(9)} ${`${row.inputTokens}/${row.outputTokens}`.padStart(12)} ${cost.padStart(11)} ${per1k.padStart(13)}`,
    );
  }
}

function printReplies(rows: readonly Row[]): void {
  console.log("\n--- replies ---");
  for (const row of rows) {
    if (row.error) continue;
    console.log(`\n[${row.model}]`);
    console.log(row.reply);
  }
}

/**
 * Cost is the easy axis. The one that decides whether a model is usable here is
 * whether it looked the stock up — a reply written without calling lookupStock
 * is invented, however cheap and fluent it reads.
 */
function printVerdict(rows: readonly Row[]): void {
  console.log("\n--- did it look the stock up? ---");
  for (const row of rows) {
    if (row.error) {
      console.log(`  ${row.model}: failed`);
      continue;
    }
    const looked = row.toolsCalled.includes("lookupStock");
    console.log(`  ${looked ? "yes" : "NO — answered without checking stock"}  ${row.model}`);
  }
  console.log();
}

function parseArgs(argv: readonly string[]): { models: string[]; question: string } {
  const modelsAt = argv.indexOf("--models");
  if (modelsAt === -1) {
    return { models: DEFAULT_MODELS, question: argv.join(" ") || DEFAULT_QUESTION };
  }
  const models = (argv[modelsAt + 1] ?? "").split(",").filter(Boolean);
  const rest = [...argv.slice(0, modelsAt), ...argv.slice(modelsAt + 2)];
  return {
    models: models.length > 0 ? models : DEFAULT_MODELS,
    question: rest.join(" ") || DEFAULT_QUESTION,
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
