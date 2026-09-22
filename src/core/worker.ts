import { runTurn } from "./turn.js";
import { emptyConversation } from "./turn.js";
import type { Action, ConversationState, Inbound, TurnDeps, TurnResult } from "./types.js";
import type { Job, Store } from "../stores/types.js";

/**
 * Delivers one outward effect. This is the only place the library touches a
 * real transport, and it is supplied by the caller — guarded-agent ships no
 * Meta API client.
 */
export type Deliver = (action: Action, ctx: { state: ConversationState }) => Promise<void> | void;

export interface WorkerOptions {
  store: Store;
  /**
   * Built per turn rather than passed once, so the conversation is available
   * when constructing tools that need to write through it.
   */
  deps: (state: ConversationState) => TurnDeps;
  deliver?: Deliver;
  concurrency?: number;
  pollIntervalMs?: number;
  /** How long a claimed job may run before another worker may reclaim it. */
  lockTimeoutMs?: number;
  debounceMs?: number;
  maxAttempts?: number;
  now?: () => number;
  newId?: () => string;
  retryDelayMs?: (attempt: number) => number;
  onError?: (error: unknown, job: Job) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface Worker {
  /** Processes one job if any is due. Returns false when the queue was empty. */
  runOnce(): Promise<boolean>;
  /** Polls until stopped. Resolves once every loop has exited. */
  start(): Promise<void>;
  stop(): void;
}

/**
 * The only place with ambient I/O.
 *
 * runTurn returns actions; this interprets them. Keeping that split is what
 * lets the turn be replayed in a test with no database, no network and no
 * clock.
 */
export function createWorker(options: WorkerOptions): Worker {
  const {
    store,
    deps,
    deliver,
    concurrency = 1,
    pollIntervalMs = 250,
    lockTimeoutMs,
    debounceMs,
    maxAttempts = 5,
    now = () => Date.now(),
    newId = () => crypto.randomUUID(),
    retryDelayMs = (attempt) => Math.min(2 ** attempt, 60) * 1000,
    onError,
    sleep = defaultSleep,
  } = options;

  let running = false;

  async function runOnce(): Promise<boolean> {
    const job = await store.dequeue({
      now: now(),
      ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
    });
    if (!job) return false;

    try {
      const state = (await store.load(job.conversationId)) ?? emptyConversation(job.conversationId);
      const inbound = coalesce(job);
      const result = await runTurn(state, inbound, deps(state));

      await applyTurn(result, inbound, job.conversationId);
      await store.complete(job.conversationId, {
        now: now(),
        processed: job.pending.length,
        ...(debounceMs !== undefined ? { debounceMs } : {}),
      });
    } catch (error) {
      onError?.(error, job);

      if (job.attempts >= maxAttempts) {
        // Retrying forever on a message that always fails blocks the whole
        // conversation. Drop it and leave the conversation for a person.
        await store.complete(job.conversationId, {
          now: now(),
          processed: job.pending.length,
        });
        return true;
      }

      await store.fail(job.conversationId, {
        retryAt: now() + retryDelayMs(job.attempts),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return true;
  }

  async function applyTurn(
    result: TurnResult,
    inbound: Inbound,
    conversationId: string,
  ): Promise<void> {
    await store.save(result.state);
    await store.recordTurn({
      id: newId(),
      conversationId,
      at: inbound.at,
      inbound: inbound.text,
      actions: result.actions,
      trace: result.trace,
    });

    for (const action of result.actions) {
      await deliver?.(action, { state: result.state });
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      const did = await runOnce().catch((error: unknown) => {
        // dequeue itself failed — the database is unreachable. Back off rather
        // than spinning on it.
        onError?.(error, { conversationId: "(dequeue)", pending: [], attempts: 0 });
        return false;
      });
      if (!did && running) await sleep(pollIntervalMs);
    }
  }

  return {
    runOnce,
    async start(): Promise<void> {
      if (running) return;
      running = true;
      await Promise.all(Array.from({ length: concurrency }, () => loop()));
    },
    stop(): void {
      running = false;
    },
  };
}

/**
 * Four messages in a row are one turn, not four.
 *
 * Answering each separately wastes turns and reads as not listening, so the
 * debounced batch becomes a single inbound stamped with the time of the last
 * message — which is also what the WhatsApp window is measured from.
 */
export function coalesce(job: Job): Inbound {
  const texts = job.pending.map((message) => message.text);
  const at = job.pending.at(-1)?.at ?? 0;
  return { conversationId: job.conversationId, text: texts.join("\n"), at };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
