# Architecture

## Why split a turn by decider

An agent inside a real operation fails in ways that are checkable without a
model: it called the wrong tool, it promised a discount, it never escalated, it
answered outside the channel's window. Asking one large model to both decide and
write means none of those failures has a seam you can test, gate or explain.

So every turn is split three ways.

| Colour   | Decides                                                            | Cost                | Properties                                       |
| -------- | ------------------------------------------------------------------ | ------------------- | ------------------------------------------------ |
| **code** | gates: kill switch, pause, takeover, debounce, rate limit          | none                | pure, synchronous, runs every turn               |
| **jev**  | bounded forks: intent, language, needs_human, is this action risky | fractions of a cent | typed, calibrated, ~100 ms, one request per turn |
| **llm**  | the reply, the tool arguments                                      | the expensive part  | only where the answer space is open              |

Code owns the thresholds in every case. Jev returns a probability; what counts as
"high enough" is never the model's call.

## runTurn is effect-injected, not side-effect-free

`runTurn(state, inbound, deps)` awaits the LLM, the classifier and the tools. It
never reaches for `Date.now`, `Math.random`, `fetch` or the store. Everything it
can touch arrives in `deps`:

```ts
interface TurnDeps {
  llm: (req: CompletionRequest) => Promise<Completion>;
  classifier?: Classifier;
  guards?: readonly Guard[];
  policies?: readonly Policy[];
  channel?: Channel;
  tools: readonly Tool[];
  now: () => number;
  newId: () => string;
  config: TurnConfig;
}
```

Stub those and the same input produces the same trace, byte for byte. There is a
test that asserts exactly this, and it matters more than the others: if it
fails, ambient I/O is leaking in and every other guarantee here is void.

Outward effects are returned as `actions`, never performed. `worker.ts` is the
only module with ambient I/O.

## Why the tool loop is in core, not the provider

Both major APIs have a tool loop helper. Neither is usable here, for two
reasons: every tool call has to pass the policy layer _before_ it runs, and the
same loop has to work against Anthropic's Messages API and OpenAI-shaped
chat/completions alike. So the provider shrinks to one method:

```ts
interface Provider {
  complete(req: CompletionRequest): Promise<Completion>;
}
```

Translation lives in each provider. The most consequential piece of it: Anthropic
requires every `tool_result` for one assistant turn inside a **single** user
message, while OpenAI-shaped APIs take one message per result. Emitting one
message per result to Anthropic is an API error; splitting them teaches the model
to stop issuing calls in parallel. `toAnthropicMessages` groups them.

## The trace

Entries are appended as each step completes, never assembled at the end — if a
turn throws halfway through, everything decided up to that point is still on the
record.

```ts
interface TraceEntry {
  step: string; // "preCheck" | "classify" | "tool:lookupStock" | "policy:veto(sendQuote)"
  by: "code" | "jev" | "llm";
  outcome: string; // "ok" | "skipped:paused" | "block" | "escalate" | "deferred:…"
  detail?: Record<string, unknown>;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
}
```

`explain(turn)` is a projection of this. It is the debugging story: in production
the question is never "what did the model say", it is "which of the three colours
made this call, and on what evidence".
