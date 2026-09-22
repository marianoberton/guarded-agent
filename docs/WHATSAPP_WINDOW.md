# The WhatsApp 24-hour window

WhatsApp lets a business reply freely only within 24 hours of the customer's
last message. Outside that window, only an approved template may be sent.

This is enforced by the runtime rather than asked of the prompt, because a model
that has been told about a deadline is not a mechanism — it is a suggestion that
fails silently at 24 hours and one minute.

## How it is computed

From `lastCustomerMessageAt`, per conversation, in the store. Never from the
ambient clock: `windowState(lastCustomerMessageAt, now, windowMs)` takes `now`
as an argument, which is what makes every case testable against a fake clock.

A conversation where the customer has never written has no window at all. A
business cannot start a free-form WhatsApp conversation.

## What happens outside it

```ts
new WhatsAppChannel({ windowHours: 24, templates: { reopen: "hello_again" } });
```

| Situation                        | `plan()` returns | Effect                                              |
| -------------------------------- | ---------------- | --------------------------------------------------- |
| inside the window                | `free_form`      | the reply is sent                                   |
| shut, reopen template configured | `template`       | template goes out, conversation → `awaiting_reopen` |
| shut, no template                | `deferred`       | nothing is sent                                     |

In both closed cases the reply the agent had written travels back as
`pendingText`. Neither path drops it silently, and the trace says which happened
— the difference between a deferred message and an agent that appears to have
answered.

## Reopening

The customer writing is what reopens a shut window, so an `awaiting_reopen`
conversation returns to `agent` at the start of the next turn, before the gates
run. The trace records it as `window / reopened`.

The pending text is deliberately **not** flushed automatically. By the time the
customer replies, a day-old draft is usually stale; it is on the record for a
person to decide about.

## Other channels

`WebChannel` has no window: the page is open, the message goes out. It mostly
exists to keep the seam honest — if WhatsApp were the only channel, the window
would have quietly become part of the core instead of a property of one
transport.

A channel owns its rules, not its wire. This library ships no Meta API client:
`plan()` is pure and synchronous so the rules can be tested, and putting bytes
on the wire is the caller's job, via the worker's `deliver`.
