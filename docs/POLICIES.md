# Policies

A policy inspects a proposed action and may veto it.

```ts
type Verdict =
  | { type: "allow" }
  | { type: "block"; reason: string; toolResultText?: string }
  | { type: "escalate"; reason: string }
  | { type: "rewrite"; reason: string; args?: unknown; text?: string };
```

`rewrite` carries the replacement, not an instruction to produce one. A policy
that asks the model to try again has handed the decision back to the thing it
was supposed to be constraining.

## Three hooks

| Hook       | When                                             | Typical use                                 |
| ---------- | ------------------------------------------------ | ------------------------------------------- |
| `before`   | after classification, before the model is called | escalate on intent — cheapest possible exit |
| `onAction` | for every tool call, before it executes          | veto, riskGate, requireApproval             |
| `after`    | on the outbound message, before it is sent       | forbidden terms, rewriting                  |

Hooks are async because a policy is allowed to ask Jev. That is the entire
reason `riskGate` can exist.

## Ordering

Policies are evaluated in declaration order and **the first non-allow verdict
short-circuits the rest**. The rule is arbitrary, but it has to be something,
and "first to object wins" is what you can reason about reading a list top to
bottom.

Order them cheapest-first. A choice already computed this turn costs nothing to
read; `riskGate` costs a request. There is no point paying for a risk score on a
conversation that was going to a person anyway.

## The two halves of the veto story

**`veto`** is deterministic. No model, no probability, no threshold to tune. If
the rule can be written as a predicate, write it here:

```ts
policies.veto({ tool: sendQuote, when: (c) => c.args.discountPct > 10 });
```

Pass the tool object rather than its name and the argument type is inferred from
its zod schema — the predicate needs no annotation.

**`riskGate`** is probabilistic, for the rules you cannot enumerate:

```ts
policies.riskGate({
  jev: jevClient,
  question: jev.noul("Is this something the business would not want done automatically?"),
  blockAbove: 0.8,
  escalateAbove: 0.5,
});
```

It only inspects side-effecting tools by default. Asking whether reading a stock
list is risky costs a request and answers itself.

## Escalation inside a batch of parallel calls

When a policy escalates partway through a batch, the remaining `tool_result`
entries are still produced — the API requires one per `tool_use` — but none of
the remaining tools run, and the batch is not sent back to the model. Acting
after handing over is acting when you are no longer the one in charge.

## maxTurnsWithoutProgress

"Progress" means a tool ran: the agent acted rather than only produced prose. A
blocked call does not count. A purely conversational agent that never calls
tools should not use this policy — for one that is supposed to book visits and
send quotes, a run of replies with no tool call is a conversation going nowhere.
