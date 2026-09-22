import type { Action, ConversationState, Inbound, TraceEntry } from "../core/types.js";

export interface StoredTurn {
  id: string;
  conversationId: string;
  at: number;
  inbound: string;
  actions: Action[];
  trace: TraceEntry[];
}

export interface PendingMessage {
  text: string;
  at: number;
}

export interface Job {
  conversationId: string;
  /** Everything that arrived since the last turn, oldest first. */
  pending: PendingMessage[];
  attempts: number;
}

export interface EnqueueOptions {
  now: number;
  /**
   * How long to wait for the customer to stop typing. A new message pushes the
   * scheduled run forward rather than adding a second job.
   */
  debounceMs?: number;
}

export interface DequeueOptions {
  now: number;
  /** A job locked longer than this is considered abandoned and reclaimed. */
  lockTimeoutMs?: number;
}

export interface FailOptions {
  retryAt: number;
  error: string;
}

export interface CompleteOptions {
  now: number;
  /**
   * How many of the claimed messages the turn actually handled. They are
   * removed only now — claiming a job does not consume its messages, so a
   * worker that dies mid-turn loses nothing.
   */
  processed: number;
  debounceMs?: number;
}

/**
 * The queue.
 *
 * There is at most one pending job per conversation, and its scheduled time
 * moves forward with each new message. That single decision does three things
 * at once: it debounces the customer who sends four messages in a row, it
 * guarantees two turns of the same conversation never run concurrently, and it
 * keeps the table small.
 */
export interface Queue {
  /** Records an inbound message and schedules (or reschedules) its turn. */
  enqueue(inbound: Inbound, options: EnqueueOptions): Promise<void>;
  /**
   * Claims one due job and reports its pending messages. Returns null when
   * nothing is due. Safe to call from many workers at once.
   *
   * The messages stay in the row: a claim is a lock, not a consumption. That is
   * what makes a dead worker recoverable — its lock expires and the messages
   * are still there. The cost is at-least-once delivery, which is inherent to
   * any queue without two-phase commit.
   */
  dequeue(options: DequeueOptions): Promise<Job | null>;
  /**
   * Removes the handled messages and releases the job. If more arrived while it
   * ran, the job stays and is rescheduled rather than deleted.
   */
  complete(conversationId: string, options: CompleteOptions): Promise<void>;
  /** Releases a failed job so it can be retried. Its messages were never removed. */
  fail(conversationId: string, options: FailOptions): Promise<void>;
}

export interface Store extends Queue {
  load(conversationId: string): Promise<ConversationState | null>;
  save(state: ConversationState): Promise<void>;
  recordTurn(turn: StoredTurn): Promise<void>;
  getTurn(turnId: string): Promise<StoredTurn | null>;
}
