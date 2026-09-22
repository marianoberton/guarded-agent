# guarded-agent — CLAUDE.md

Runtime for conversational AI agents that run **inside a real operation**: every reply passes deterministic gates, bounded decisions (intent, escalate?, is this action safe?) go to a **System One decision model (Jev)** instead of the LLM, risky actions can be vetoed or escalated, a human can take over any conversation, and the channel's rules (WhatsApp's 24-hour window) are enforced by the runtime, not the prompt.

Library, not product. Publishes the patterns, not the business.

## The three colours

Every turn is split by who decides:

- **Code** decides the gates: kill switch, pause, debounce, window, rate limit. No model.
- **Jev** decides at bounded forks: intent, language, escalate?, which tool family, is this proposed action risky? Typed answers with probabilities, ~100 ms, near-zero cost. Code owns the thresholds.
- **LLM** writes: the reply, the tool arguments. Only where the answer space is open.

Any of the three is swappable: `JevClassifier` can be replaced by `LlmClassifier` (a small chat model) with the same interface, and the trace records which one decided. That comparison is a first-class feature, not an afterthought.

## The five patterns

1. **Turn-per-job** — webhook persists and enqueues, never calls a model. A worker runs one turn per job.
2. **Pre-check without a model** — the code gates above.
3. **Veto paths** — policies inspect a proposed action (tool call or outbound message) and return `allow | block | escalate | rewrite`. A policy may ask Jev.
4. **Tools-return-prompt** — every tool returns text that becomes the next prompt segment; every write is a store function. The model never touches state.
5. **Human takeover** — `agent → handoff_requested → human → agent`, respected on every turn.

## Non-goals

No UI, no console, no multi-tenant plumbing, no RAG (retrieval is a tool), not a workflow engine.

## Stack

- TypeScript, ESM, Node 20+. Runtime deps: `zod`, provider SDKs.
- Providers: `AnthropicProvider`, `OpenRouterProvider` (LLM roles); `JevProvider` via TypeSafe API with `baseUrl` override (OpenRouter / Vercel AI Gateway / Cloudflare). Read https://docs.typesafe.ai and install `npx skills add typesafe-ai/skills --skill typesafe-ai` before writing the client.
- Stores: `MemoryStore`, `PostgresStore` (`pg`, plain SQL; queue = `jobs` table with `SKIP LOCKED`).
- Tests: Vitest. Evals: `agent-evals` (sibling repo) against the pure `runTurn()`.

## Public API (v0.1)

```ts
import { createAgent, MemoryStore, WhatsAppChannel, JevClassifier, policies, jev } from "guarded-agent";

const agent = createAgent({
  store: new MemoryStore(),
  channel: new WhatsAppChannel({ windowHours: 24, templates: { reopen: "hello_again" } }),
  classifier: new JevClassifier({
    questions: {
      intent: jev.choice("What does the customer want?", {
        stock_question: "Availability, models, versions, colours",
        price_question: "Asks a price or a quote",
        price_negotiation: "Pushes for a discount or a lower price",
        visit: "Wants to see or test a car",
        asks_for_human: "Explicitly wants a person",
        other: "None of these",
      }),
      language: jev.choice("Language of the message", { es: "Spanish", en: "English", pt: "Portuguese" }),
      needs_human: jev.noul("Should a human take this conversation now?"),
    },
  }),
  models: { responder: "claude-sonnet-4-6" },
  system: "You are the sales assistant for ...",
  tools: [lookupStock, bookVisit, sendQuote],
  policies: [
    policies.escalateWhen({ intent: "price_negotiation" }),
    policies.escalateWhen({ noul: "needs_human", above: 0.85 }),
    policies.veto({ tool: "sendQuote", when: (c) => c.args.discountPct > 10 }),
    policies.riskGate({                       // Jev checks every side-effecting tool call
      question: jev.noul("Is this action something the business would not want done automatically?"),
      blockAbove: 0.8, escalateAbove: 0.5,
    }),
    policies.maxTurnsWithoutProgress(4),
  ],
  guards: { killSwitch: () => env.AGENT_ENABLED === "true", debounceMs: 30_000 },
});

app.post("/webhook", async (req, res) => { await agent.ingest(req.body); res.sendStatus(200); });
await agent.worker({ concurrency: 4 }).start();
```

Interfaces the user can implement: `Store`, `Channel`, `Provider`, `Classifier`, `Policy`.

## Turn lifecycle

```
ingest(inbound)  → store.appendMessage + store.enqueue          [code]
worker
  ├─ preCheck()   kill switch → paused/human → debounce → window → rate limit   [code]  ⇒ skipped:<reason>
  ├─ classify()   one Jev request, all questions in parallel    [jev]  (or LlmClassifier)
  ├─ policies.before()  may short-circuit to escalate            [code, may ask jev]
  ├─ respond()    responder LLM + tools loop                     [llm]
  │     each tool call → policies.onAction() → allow|block|escalate|rewrite   [code / jev]
  │     tool result text appended as next prompt segment
  ├─ policies.after()  outbound message check                    [code / jev]
  ├─ channel.send()   outside 24 h ⇒ template or `deferred`      [code]
  └─ store.record(turn)  trace: gates, jev answers + probabilities, llm calls, latency, cost
```

`agent.explain(turnId)` returns the chain of decisions with who made each and with what probability. That is the debugging story and the interview story.

## Takeover state machine

```
agent ──(escalate | human clicks)──▶ handoff_requested ──(human accepts)──▶ human
  ▲                                                                          │
  └──────────────────(human releases | inactivity timeout)───────────────────┘
```

In `human`, `preCheck()` skips the turn and stores the message for the human. Release re-summarises the human's messages into the agent context.

## WhatsApp 24-hour window

Computed from the last customer message, per conversation, in the store. Inside: free-form. Outside: `templates.reopen` if configured (conversation → `awaiting_reopen`), otherwise `deferred`. A `Channel` concern; `WebChannel` has no window.

## Layout

```
src/core/        createAgent, worker, turn.ts (runTurn — pure), trace.ts, explain.ts
src/guards/      preCheck, debounce, killSwitch
src/classify/    types.ts, JevClassifier.ts, LlmClassifier.ts
src/policies/    types, escalateWhen, veto, riskGate, requireApproval, progress
src/channels/    types, whatsapp/, web/
src/providers/   types, anthropic, openrouter, jev
src/stores/      types, memory, postgres/ (schema.sql, store.ts)
src/tools/       defineTool (zod → provider tool + text return)
examples/dealership/  fictional stock, 3 tools, 5 policies, in-memory; `npm run example`
examples/express/     webhook + worker + PostgresStore
evals/           agent-evals suites for the dealership example (jevJudge included)
docs/            ARCHITECTURE (three-colour diagram), POLICIES, JEV, WHATSAPP_WINDOW
```

## Milestones

| | Deliverable | Done when |
|---|---|---|
| M0 | `runTurn()` pure + `MemoryStore` + `AnthropicProvider` + `defineTool` + `LlmClassifier` | dealership example answers a stock question with a recorded response |
| M1 | `JevProvider` + `JevClassifier` (one batched request) + guards + trace + `explain()` | classify step shows jev answers with probabilities; kill switch / debounce / pause each produce `skipped:*` |
| M2 | policies (`escalateWhen`, `veto`, `riskGate`, `requireApproval`, `maxTurnsWithoutProgress`) + takeover machine | discount > 10 % blocked; "quiero hablar con una persona" → `handoff_requested`; `riskGate` blocks a fake `deleteCustomer` |
| M3 | `WhatsAppChannel` window + templates; `WebChannel` | fake-clock tests for outside-window |
| M4 | `PostgresStore` + queue + `worker()` + express example | two workers, 100 jobs, no double-processing |
| M5 | `agent-evals` suite in CI, README with three-colour diagram, npm 0.1.0 | clean `npm i guarded-agent` works |

M0 → M5. Don't start M3 before M2 is green.

## Rules for Claude Code

- `runTurn()` is pure: `(state, inbound, deps) → (newState, actions)`. All I/O in `worker.ts`.
- Every gate, Jev answer and policy verdict is written to the trace before the next step.
- Classifier interface is provider-agnostic; `JevClassifier` and `LlmClassifier` must be interchangeable in the example with one line.
- Never present Jev as infallible. Thresholds are the caller's; document how to pick them with `agent-evals calibrate`.
- No real client content: no real dealership names, stock, prices, prompts, logs. Fixtures are invented.
- English in code, comments, docs, commits. Conventional commits. One PR per milestone.

## Publication checklist

- [ ] Co-founder ok on publishing the patterns (nothing product-specific in the repo).
- [ ] `git log` + fixtures reviewed for real data.
- [ ] README: what it is, 30-s example, three-colour turn diagram, link to `agent-evals`.
- [ ] MIT, npm publish. Submit to madewithjev.com / awesome-jev.