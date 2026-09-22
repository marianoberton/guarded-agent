# Jev

Jev (TypeSafe System One) is not a chat model. It takes no `messages` and
returns no text. It takes a `state` and a map of typed questions, and returns
calibrated answers. Chat completion SDKs do not work against it — which is why
there is a separate client rather than a second model id on `OpenRouterProvider`.

Every question is evaluated in parallel against the same state, so adding
questions barely moves the response time. One request per turn, never one per
question.

## Wire format

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY

{
  "model": "typesafe/jev-1.13",
  "state": <string | object | array>,
  "zdr": true,
  "questions": {
    "<key>": {
      "type": "noul" | "choice" | "score",
      "instructions": "...",
      "criteria": {…} | {"true": …, "false": …} | [levels…]
    }
  }
}
```

```json
{
  "answers": {
    "<key>": {
      "type": "…",
      "noul": 0.0,
      "choice": "…",
      "probabilities": {},
      "score": 0.0,
      "confidence": 0.0
    }
  },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

`zdr: true` restricts routing to zero-data-retention providers. It is on by
default here, because this endpoint sees customer conversations.

The same OpenRouter key covers both roles: the responder LLM at
`/api/v1/chat/completions` and Jev at `/api/alpha/decisions`.

## Question types

```ts
jev.noul("Should a human take this conversation now?");
jev.noul("Is it noise?", { true: "Bulk or automated…", false: "Written by a person…" });

jev.choice("What does the customer want?", {
  stock_question: "Availability, models, versions, colours",
  price_negotiation: "Pushes for a discount",
  other: "None of these",
});

jev.score("How urgent is this?", ["Not at all", "Some time this week", "Today or tomorrow"]);
```

The `criteria` are the only real quality lever. They are worth writing carefully
— more carefully than the instructions.

## Cost and limits

Input is billed at roughly $0.042 per million tokens; output is free. A decision
with a compact state costs fractions of a cent. Context is about 64k tokens
combined, of which roughly 32k is available for the state, so long histories
should be trimmed before they are sent.

OpenRouter allows 1200 requests per minute. `JevProvider` defaults to 15 req/s,
which leaves margin, and shares one limiter across concurrent callers — slots
are reserved synchronously so callers queue instead of all reading the same
clock and firing at once.

## Thresholds

**Never present Jev as infallible.** It cannot return an invalid type. It can
return a wrong valid one.

That is why every threshold in this library belongs to the caller:

```ts
policies.escalateWhen({ noul: "needs_human", above: 0.85 })
policies.riskGate({ …, blockAbove: 0.8, escalateAbove: 0.5 })
```

0.85 is not a recommendation. Pick these by measuring probabilities against
labelled outcomes — `agent-evals calibrate` prints a reliability table for
exactly this — and revisit them when the question text changes, because changing
the wording changes the calibration.

## Swapping it out

`LlmClassifier` answers the same question map with a chat model and returns the
same shapes, so it drops into the same slot with a one-line change. The trace
records `by: "jev"` or `by: "llm"` so the two can be compared.

Its probabilities are the model's self-report. They are not calibrated, and no
threshold should be gated on them without measuring first.
