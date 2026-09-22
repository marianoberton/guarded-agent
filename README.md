# guarded-agent

Runtime for conversational AI agents that run **inside a real operation**.

Every reply passes deterministic gates. Bounded decisions — intent, escalate?, is this action safe? — go to a calibrated **System One decision model (Jev)** instead of the LLM. Risky actions can be vetoed or escalated. A human can take over any conversation. The channel's rules, like WhatsApp's 24-hour window, are enforced by the runtime rather than asked of the prompt.

Library, not product. It publishes the patterns, not the business.

```bash
npm install guarded-agent
```

## The three colours

Every turn is split by who decides.

```
┌─ code ──────────────────────────────────────────────────────────────┐
│  kill switch · paused · human takeover · debounce · rate limit      │
│  no model, pure, runs on every turn                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─ jev ───────────────────────────────────────────────────────────────┐
│  intent · language · needs_human · is this action risky?            │
│  typed answers with probabilities · ~100 ms · fractions of a cent   │
│  one request per turn, every question answered in parallel          │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─ llm ───────────────────────────────────────────────────────────────┐
│  the reply · the tool arguments                                     │
│  only where the answer space is genuinely open                      │
└─────────────────────────────────────────────────────────────────────┘
```

Code owns the thresholds. The LLM writes; it does not decide. And any of the three is swappable: `JevClassifier` and `LlmClassifier` implement the same interface, and the trace records which one answered — that comparison is a feature, not an afterthought.

## The turn

```
ingest(inbound)  → store.enqueue                                    [code]
worker
  ├─ preCheck()        kill switch → paused → human → debounce      [code]  ⇒ skipped:<reason>
  ├─ classify()        one Jev request, all questions in parallel   [jev]   (or LlmClassifier)
  ├─ policies.before() may short-circuit to escalate                [code, may ask jev]
  ├─ respond()         responder LLM + tool loop                    [llm]
  │     each tool call → policies.onAction() → allow|block|escalate|rewrite
  │     tool result text becomes the next prompt segment
  ├─ policies.after()  outbound message check                       [code / jev]
  ├─ channel.plan()    outside 24 h ⇒ template or deferred          [code]
  └─ store.record(turn)
```

`explain(turn)` prints that chain back with who decided each step and at what probability:

```
code  preCheck               ok                          0ms
jev   classify               ok                         98ms
        intent             = price_negotiation  conf=0.94
        needs_human        = 0.12
        language           = es
code  policy:escalateWhen…  escalate                     0ms
actions: setStatus:handoff_requested(intent=price_negotiation)
total: 98ms  0 tokens
```

## 30 seconds

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

const provider = new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY! });
const jevClient = new JevProvider({ apiKey: process.env.OPENROUTER_API_KEY! });
const store = new PostgresStore(pool);

const worker = createWorker({
  store,
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

## The five patterns

1. **Turn-per-job** — the webhook persists and enqueues, never calls a model. A webhook that waits for an LLM is a webhook that times out while the platform retries it.
2. **Pre-check without a model** — kill switch, pause, takeover, debounce, rate limit. Pure and synchronous: a kill switch that needs a network call is not a kill switch.
3. **Veto paths** — policies inspect a proposed action and return `allow | block | escalate | rewrite`. A policy may ask Jev.
4. **Tools-return-prompt** — every tool returns text that becomes the next prompt segment, and every write goes through a store function. The model never touches state.
5. **Human takeover** — `agent → handoff_requested → human → agent`, respected on every turn, with an inactivity timeout so one forgotten tab cannot silence an agent forever.

## Interfaces you can implement

`Store`, `Channel`, `Provider`, `Classifier`, `Policy`, `Tool`.

`runTurn()` is effect-injected rather than side-effect-free: it awaits the LLM, the classifier and the tools, but never reaches for `Date.now`, `Math.random`, `fetch` or the store. Stub its `deps` and the same input produces the same trace, byte for byte. That is what makes the suite deterministic and lets [`agent-evals`](https://github.com/marianoberton/agent-evals) replay it.

## Honest limits

- **Jev is not infallible.** It cannot return an invalid type. It can return a wrong valid one. Every threshold in this library is yours to choose, and the honest way to choose one is to measure it against labelled outcomes — not to pick a number that sounds careful.
- **The queue is at-least-once.** A claim is a lock, not a consumption, so a worker that dies mid-turn loses nothing when its lock expires — but a worker that dies after sending and before committing will reprocess. No queue avoids that without two-phase commit.
- **`AnthropicProvider` has never run against the live API.** This project runs on OpenRouter and has no Anthropic key. Its request/response translation is covered by tests in both directions, which is where format bugs live; the network path is unverified. `OpenRouterProvider` is the one in daily use.
- **No transport is included.** A channel owns its rules, you own its wire. There is no Meta API client here, deliberately — a channel that needed one could not be unit-tested.
- **Not a workflow engine, not a RAG framework** (retrieval is a tool), no UI, no multi-tenant plumbing.

## Running it

```bash
npm test              # offline: no network, no database
npm run typecheck
npm run example       # one turn against OpenRouter
npm run compare       # the same turn across several models, with cost and latency
npm run ping          # smallest possible Jev check

npm run db:up         # Postgres for the integration test
npm run test:db       # two workers, 100 jobs, no double processing
npm run test:live     # smoke tests that cost real money
```

Copy `.env.example` to `.env` and fill in `OPENROUTER_API_KEY`. One key covers both roles: the responder LLM and Jev decisions.

## Choosing a responder

The responder is a string in `.env`, not a dependency — `OpenRouterProvider` speaks the OpenAI shape, so any model in the catalogue works. `npm run compare` runs the same turn across several and reports tokens, latency and real cost. But the column that decides is not cost:

```
--- did it look the stock up? ---
  yes  google/gemini-2.5-flash-lite
  NO — answered without checking stock  <some cheaper model>
```

A fluent reply written without calling `lookupStock` is invented, however cheap. Cost is the tiebreaker, not the criterion.

## Docs

- [ARCHITECTURE](docs/ARCHITECTURE.md) — the three colours, the turn, the trace
- [POLICIES](docs/POLICIES.md) — verdicts, ordering, and which half of the veto story to reach for
- [JEV](docs/JEV.md) — the wire format, thresholds, and how to pick them
- [WHATSAPP_WINDOW](docs/WHATSAPP_WINDOW.md) — the 24-hour rule and what happens outside it

## License

MIT
