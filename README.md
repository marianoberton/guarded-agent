# guarded-agent

[![ci](https://github.com/marianoberton/guarded-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/marianoberton/guarded-agent/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

A TypeScript runtime for conversational agents that run inside a real operation — where a wrong answer costs money, and "we told the model not to" is not a control.

---

Production agents fail in ways a prompt cannot prevent. They offer a discount the business will not honour. They reply outside the channel's legal send window. They keep talking when a person should have taken over. They call a destructive tool because, in context, the model judged it reasonable.

Every one of those is a decision. The usual design hands all of them to one large model and hopes the system prompt holds. `guarded-agent` takes them back.

## The idea: split every turn by who decides

```
┌─ code ──────────────────────────────────────────────────────────────┐
│  kill switch · paused · human takeover · debounce · rate limit      │
│  pure, synchronous, no model, runs on every turn                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─ jev ───────────────────────────────────────────────────────────────┐
│  intent · language · needs_human · is this action risky?            │
│  typed answers with probabilities · ~400 ms · $0.00002 per turn     │
│  one request, every question evaluated in parallel                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─ llm ───────────────────────────────────────────────────────────────┐
│  the reply · the tool arguments                                     │
│  only where the answer space is genuinely open                      │
└─────────────────────────────────────────────────────────────────────┘
```

The middle tier is the part that is not obvious. Classification, escalation and risk assessment have small, knowable answer spaces — exactly where a System One decision model ([Jev](https://docs.typesafe.ai), via OpenRouter) belongs and a chat model is both overkill and unaccountable. It returns a calibrated probability instead of prose, so a threshold on it is a real gate rather than a vibe.

**Code owns every threshold.** Jev reports 0.90; what counts as high enough is never the model's call.

## What that buys you

Two real runs of the same agent, from `npm run example`. The first is a stock question:

```
code  preCheck               ok                        0ms
jev   classify               ok                      454ms
        intent             = stock_question  conf=1.00
        language           = es  conf=1.00
        needs_human        = 0.08
llm   respond                tool_use               1482ms  173in/161out  $0.000082
code  tool:lookupStock       ok                       29ms
llm   respond                end                     577ms  218in/25out   $0.000032
code  send                   ok                        0ms

total: 2542ms  577 tokens  $0.000113
```

The second is a customer pushing for a discount:

```
code  preCheck               ok                        0ms
jev   classify               ok                      431ms
        intent             = price_negotiation  conf=0.90
        needs_human        = 0.58
code  policy:escalateWhen(intent=price_negotiation)  escalate   0ms

actions: setStatus:handoff_requested(intent=price_negotiation)
total: 431ms  0 tokens
```

**Zero responder tokens.** The conversation reached a human in 431 ms because the decision was made at a typed fork, before the expensive model was ever asked. Under the usual design that same turn is a full LLM call that might have negotiated.

That output is `explain(turn)`, and it is the reason the trace records `by` on every step. In production the question is never "what did the model say" — it is _which of the three made this call, and on what evidence_.

## What it costs

Measured with `npm run compare`, which runs one real turn across several responders and reports what OpenRouter actually billed:

| responder                      | called `lookupStock` |   latency | per 1,000 turns |
| ------------------------------ | :------------------: | --------: | --------------: |
| `google/gemini-2.5-flash-lite` |         yes          |  1,805 ms |       **$0.05** |
| `qwen/qwen3-30b-a3b-instruct`  |         yes          |  8,281 ms |           $0.16 |
| `openai/gpt-5-nano`            |         yes          | 12,166 ms |           $0.43 |
| `anthropic/claude-haiku-4.5`   |         yes          |  2,593 ms |           $2.83 |

The responder is a string in `.env`, not a dependency — the provider speaks the OpenAI shape, so any model in the catalogue works. But cost is the tiebreaker, not the criterion. The column that decides is the second one: a fluent reply written _without_ calling `lookupStock` is invented, however cheap. `compare` prints that verdict separately for exactly this reason.

Classification runs on Jev at roughly $0.02 per thousand turns, which is what makes it affordable to ask three questions on every single message.

## Install

```bash
npm install guarded-agent
```

```ts
import {
  createWorker,
  JevClassifier,
  JevProvider,
  jev,
  OpenRouterProvider,
  policies,
  PostgresStore,
  standardGuards,
  WhatsAppChannel,
} from "guarded-agent";

const worker = createWorker({
  store: new PostgresStore(pool),
  concurrency: 4,
  debounceMs: 30_000,

  deps: () => ({
    llm: (req) => provider.complete(req),

    classifier: new JevClassifier({
      jev: jevClient,
      questions: {
        intent: jev.choice("What does the customer want?", {
          stock_question: "Availability, models, versions, colours",
          price_negotiation: "Pushes for a discount or a lower price",
          asks_for_human: "Explicitly wants a person",
          other: "None of these",
        }),
        needs_human: jev.noul("Should a human take this conversation now?"),
      },
    }),

    guards: standardGuards({
      killSwitch: () => process.env.AGENT_ENABLED === "true",
      debounceMs: 30_000,
      rateLimit: { max: 10, windowMs: 60_000 },
    }),

    policies: [
      policies.escalateWhen({ intent: "price_negotiation" }),
      policies.escalateWhen({ noul: "needs_human", above: 0.85 }),
      policies.veto({ tool: sendQuote, when: (c) => c.args.discountPct > 10 }),
      policies.riskGate({
        jev: jevClient,
        question: jev.noul("Is this something the business would not want done automatically?"),
        blockAbove: 0.8,
        escalateAbove: 0.5,
      }),
      policies.maxTurnsWithoutProgress(4),
    ],

    channel: new WhatsAppChannel({ windowHours: 24, templates: { reopen: "hello_again" } }),
    tools: [lookupStock, bookVisit, sendQuote],
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    config: {
      system: SYSTEM,
      model: "google/gemini-2.5-flash-lite",
      maxTokens: 1024,
      maxToolIterations: 5,
    },
  }),

  deliver: async (action) => {
    /* your transport */
  },
});

// The webhook persists and enqueues. It never calls a model.
app.post("/webhook", async (req, res) => {
  await store.enqueue(toInbound(req.body), { now: Date.now(), debounceMs: 30_000 });
  res.sendStatus(200);
});

await worker.start();
```

`policies.veto` takes the tool object rather than its name, so `c.args` is typed from that tool's zod schema with no annotation.

## How a turn runs

```
ingest(inbound)  → store.enqueue                                    [code]
worker
  ├─ preCheck()        kill switch → paused → human → debounce      [code]  ⇒ skipped:<reason>
  ├─ classify()        one Jev request, all questions in parallel   [jev]   (or LlmClassifier)
  ├─ policies.before() may short-circuit to escalate                [code, may ask jev]
  ├─ respond()         responder LLM + tool loop                    [llm]
  │     every tool call → policies.onAction() → allow|block|escalate|rewrite
  │     tool result text becomes the next prompt segment
  ├─ policies.after()  outbound message check                       [code / jev]
  ├─ channel.plan()    outside 24 h ⇒ template or deferred          [code]
  └─ store.record(turn)
```

## Design decisions worth explaining

Most of this library is ordinary. These five are where the interesting choices live.

### `runTurn` is effect-injected, not side-effect-free

It awaits the LLM, the classifier and the tools. It never reaches for `Date.now`, `Math.random`, `fetch` or the store — all of it arrives in `deps`:

```ts
runTurn(state, inbound, { llm, classifier, guards, policies, channel, tools, now, newId, config })
  => { state, actions, trace }
```

Stub those and the same input produces the same trace, byte for byte. One test asserts exactly that, and it matters more than the rest of the suite: if it fails, ambient I/O is leaking in and every other guarantee here is void. It is also what lets a fake clock test the 24-hour window, and what will let an eval harness replay recorded turns.

Outward effects are _returned_ as actions, never performed. `worker.ts` is the only module with ambient I/O.

### The tool loop lives in core, not in a provider

Both major SDKs ship a tool-loop helper. Neither is usable here, for two reasons: every tool call has to pass the policy layer _before_ it runs, and the same loop has to work against Anthropic's Messages API and OpenAI-shaped chat completions. So the provider shrinks to one method — `complete(request) => Completion` — and each one translates.

The consequential part of that translation: Anthropic requires every `tool_result` for one assistant turn inside a **single** user message, while OpenAI-shaped APIs take one message per result. Emitting one message per result to Anthropic is an API error, and splitting them trains the model to stop issuing calls in parallel at all. There is a test pinning the grouping.

### A queue claim is a lock, not a consumption

The `jobs` table is keyed by conversation, so a second message cannot create a second job — it extends the existing one and pushes its scheduled run forward. One primary key does three jobs at once: it debounces the customer who sends four messages in a row, it makes two concurrent turns of one conversation impossible, and it keeps the table small.

Claiming uses `FOR UPDATE SKIP LOCKED`, and leaves the pending messages in the row. An earlier design took them out with the claim; a test caught what that means when a worker dies mid-turn — the messages go with it, unrecoverably. Now the lock simply expires and another worker picks them up. The price is at-least-once delivery, which no queue avoids without two-phase commit.

Verified against real Postgres: two workers drain 100 jobs and produce exactly one turn per conversation.

### Policies short-circuit, cheapest first

A policy inspects a proposed action and returns `allow | block | escalate | rewrite`. They run at three points — before the model is called, before each tool executes, and on the outbound message — and they may ask Jev, which is why the hooks are async.

Evaluation stops at the first non-allow verdict. The rule is arbitrary but it has to be _something_, and "first to object wins" is what you can reason about reading a list top to bottom. Order them cheapest first: a choice already computed this turn is free to read, while `riskGate` costs a request. There is no point pricing the risk of a conversation that was going to a person anyway.

`rewrite` carries the replacement, not an instruction to produce one. A policy that asks the model to try again has handed the decision back to the thing it was meant to constrain.

### The channel's rules are runtime rules

WhatsApp allows a free-form reply only within 24 hours of the customer's last message. A model that has been _told_ about that deadline is not a mechanism — it is a suggestion that fails silently at 24 hours and one minute.

So the window is computed from the store, in code, against an injected clock. Outside it, a configured template reopens the conversation or the message is deferred; either way the reply the agent had written comes back as `pendingText` rather than disappearing, and the trace says which happened. That is the difference between a deferred message and an agent that appears to have answered.

`WebChannel` has no window at all. It mostly exists to keep the seam honest — with only one channel, the window would have quietly become part of the core instead of a property of one transport.

## Testing

Three suites, each proving something the others cannot.

```bash
npm test          # 158 tests · no network, no database, no API keys
npm run test:db   #  11 tests · real Postgres via docker compose
npm run test:live #   3 tests · real OpenRouter, costs about a cent
```

The offline suite runs entirely on injected stubs, so it is fast, free and deterministic — including the byte-for-byte trace comparison above. The Postgres suite exists because `SKIP LOCKED` cannot be proven in a single process against an in-memory fake. The live suite exists because a request shape that typechecks is not a request shape the API accepts.

`node scripts/check-fixtures.mjs` runs in CI and fails the build on anything resembling a real phone number, email or API key. Every fixture in this repository is invented; no client data appears anywhere in it, including the git history.

## Limits

- **Jev is not infallible.** It cannot return an invalid type. It can return a wrong valid one. Every threshold here belongs to the caller, and the honest way to choose one is to measure it against labelled outcomes — not to pick a number that sounds careful. `LlmClassifier` drops into the same slot for comparison, but its probabilities are the model's self-report and are not calibrated.
- **The queue is at-least-once.** A worker that dies after sending but before committing will reprocess.
- **`AnthropicProvider` has never run against the live API.** This project runs on OpenRouter and has no Anthropic key. Its translation is covered by tests in both directions, which is where format bugs live; the network path is unverified, and the README should say so rather than let you find out.
- **No transport is included.** A channel owns its rules; you own its wire. There is deliberately no Meta API client here — a channel that needed one could not be unit-tested.
- Not a workflow engine, not a RAG framework (retrieval is a tool), no UI, no multi-tenant plumbing.

## Running it locally

```bash
cp .env.example .env    # one OpenRouter key covers both the responder and Jev
npm run example         # one turn, with explain() output
npm run example -- "¿Me lo dejás en 15?"   # the escalation path
npm run compare         # the same turn across four responders
npm run ping            # smallest possible Jev check
npm run db:up && npm run example:express   # webhook + worker + Postgres
```

## Docs

|                                            |                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------- |
| [ARCHITECTURE](docs/ARCHITECTURE.md)       | the three colours, the turn, the trace                            |
| [POLICIES](docs/POLICIES.md)               | verdicts, ordering, and which half of the veto story to reach for |
| [JEV](docs/JEV.md)                         | wire format, cost, and how to pick a threshold                    |
| [WHATSAPP_WINDOW](docs/WHATSAPP_WINDOW.md) | the 24-hour rule and what happens outside it                      |

## License

MIT — see [LICENSE](LICENSE).
