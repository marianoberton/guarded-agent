import { proceed, skip, type Guard, type GuardContext, type GuardVerdict } from "./types.js";

export type { Guard, GuardContext, GuardVerdict } from "./types.js";
export { proceed, skip } from "./types.js";

/**
 * Runs the gates in order; the first skip wins and nothing after it runs.
 *
 * Order is the caller's, and it matters: put the cheap absolute ones first
 * (kill switch, paused) so an agent that is switched off never evaluates
 * anything else.
 */
export function preCheck(guards: readonly Guard[], ctx: GuardContext): GuardVerdict {
  for (const guard of guards) {
    const verdict = guard.check(ctx);
    if (verdict.type === "skip") return verdict;
  }
  return proceed;
}

/**
 * The switch you reach for when the agent is doing something wrong in
 * production and you need it to stop answering right now.
 *
 * Reads a predicate rather than a boolean so it re-evaluates every turn — a
 * value captured at construction is a switch that cannot be flipped.
 */
export function killSwitch(isEnabled: () => boolean): Guard {
  return {
    name: "killSwitch",
    check: () => (isEnabled() ? proceed : skip("killswitch")),
  };
}

/** A conversation an operator has explicitly parked. */
export function paused(): Guard {
  return {
    name: "paused",
    check: ({ state }) => (state.status === "paused" ? skip("paused") : proceed),
  };
}

/**
 * While a human owns the conversation the agent stays out of it.
 *
 * The inbound message is still appended to the conversation before this runs,
 * so the person taking over sees everything that arrived while they held it.
 */
export function humanTakeover(): Guard {
  return {
    name: "humanTakeover",
    check: ({ state }) =>
      state.status === "human" || state.status === "handoff_requested"
        ? skip(`human:${state.status}`)
        : proceed,
  };
}

/**
 * Wait for the customer to stop typing.
 *
 * People send three messages in a row. Answering the first one wastes a turn and
 * reads as not listening. This is the per-turn half: a message younger than
 * `ms` is skipped and the job runs again later. The other half is the queue
 * (M4), where a new inbound pushes the conversation's scheduled run forward
 * instead of enqueuing a second job.
 */
export function debounce(ms: number): Guard {
  return {
    name: "debounce",
    check: ({ inbound, now }) => {
      const age = now - inbound.at;
      return age < ms ? skip("debounce", { ageMs: age, debounceMs: ms }) : proceed;
    },
  };
}

export interface RateLimitOptions {
  /** Replies allowed inside the window. */
  max: number;
  windowMs: number;
}

/**
 * Caps how often the agent may reply to one conversation.
 *
 * Counts what the agent actually sent, not what arrived: the failure this
 * protects against is a loop that keeps answering itself.
 */
export function rateLimit(options: RateLimitOptions): Guard {
  return {
    name: "rateLimit",
    check: ({ state, now }) => {
      const since = now - options.windowMs;
      const recent = state.messages.filter(
        (message) => message.role === "assistant" && message.at > since,
      ).length;

      return recent >= options.max
        ? skip("rate_limit", { recent, max: options.max, windowMs: options.windowMs })
        : proceed;
    },
  };
}

export interface StandardGuardOptions {
  killSwitch?: () => boolean;
  debounceMs?: number;
  rateLimit?: RateLimitOptions;
}

/**
 * The gates most deployments want, in the order they should run: absolute stops
 * first, then ownership, then pacing.
 */
export function standardGuards(options: StandardGuardOptions = {}): Guard[] {
  const guards: Guard[] = [];
  if (options.killSwitch) guards.push(killSwitch(options.killSwitch));
  guards.push(paused(), humanTakeover());
  if (options.debounceMs !== undefined) guards.push(debounce(options.debounceMs));
  if (options.rateLimit) guards.push(rateLimit(options.rateLimit));
  return guards;
}
