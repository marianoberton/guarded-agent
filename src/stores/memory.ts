import type { ConversationState, Inbound } from "../core/types.js";
import type {
  CompleteOptions,
  DequeueOptions,
  EnqueueOptions,
  FailOptions,
  Job,
  PendingMessage,
  Store,
  StoredTurn,
} from "./types.js";

interface JobRow {
  conversationId: string;
  pending: PendingMessage[];
  runAfter: number;
  attempts: number;
  lockedAt: number | null;
  lastError?: string;
}

/**
 * In-process store and queue. Real for examples and tests, not for production —
 * a restart loses everything and two processes share nothing.
 *
 * It implements the same queue contract as PostgresStore so the worker can be
 * tested without a database. What it cannot prove is that the SQL is correct
 * under real concurrency; that is what the Postgres integration test is for.
 *
 * State is cloned on the way in and out so a caller mutating what it got back
 * cannot corrupt what is stored. That has bitten every in-memory store ever
 * written.
 */
export class MemoryStore implements Store {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly turns = new Map<string, StoredTurn>();
  private readonly jobs = new Map<string, JobRow>();

  async load(conversationId: string): Promise<ConversationState | null> {
    const found = this.conversations.get(conversationId);
    return found ? clone(found) : null;
  }

  async save(state: ConversationState): Promise<void> {
    this.conversations.set(state.id, clone(state));
  }

  async recordTurn(turn: StoredTurn): Promise<void> {
    this.turns.set(turn.id, clone(turn));
  }

  async getTurn(turnId: string): Promise<StoredTurn | null> {
    const found = this.turns.get(turnId);
    return found ? clone(found) : null;
  }

  async enqueue(inbound: Inbound, options: EnqueueOptions): Promise<void> {
    const runAfter = options.now + (options.debounceMs ?? 0);
    const existing = this.jobs.get(inbound.conversationId);

    if (existing) {
      existing.pending.push({ text: inbound.text, at: inbound.at });
      // A new message pushes the run forward: that is the debounce.
      existing.runAfter = runAfter;
      return;
    }

    this.jobs.set(inbound.conversationId, {
      conversationId: inbound.conversationId,
      pending: [{ text: inbound.text, at: inbound.at }],
      runAfter,
      attempts: 0,
      lockedAt: null,
    });
  }

  async dequeue(options: DequeueOptions): Promise<Job | null> {
    const lockTimeoutMs = options.lockTimeoutMs ?? 5 * 60_000;
    const expiry = options.now - lockTimeoutMs;

    const due = [...this.jobs.values()]
      .filter(
        (job) =>
          job.runAfter <= options.now &&
          job.pending.length > 0 &&
          (job.lockedAt === null || job.lockedAt < expiry),
      )
      .sort((a, b) => a.runAfter - b.runAfter);

    const job = due[0];
    if (!job) return null;

    // The claim is a lock, not a consumption: the messages stay in the row so a
    // worker that dies mid-turn loses nothing when its lock expires.
    job.lockedAt = options.now;
    job.attempts += 1;

    return {
      conversationId: job.conversationId,
      pending: clone(job.pending),
      attempts: job.attempts,
    };
  }

  async complete(conversationId: string, options: CompleteOptions): Promise<void> {
    const job = this.jobs.get(conversationId);
    if (!job) return;

    job.pending = job.pending.slice(options.processed);

    if (job.pending.length === 0) {
      this.jobs.delete(conversationId);
      return;
    }

    // Something arrived while we were working. Keep the job and run again.
    job.lockedAt = null;
    job.attempts = 0;
    job.runAfter = options.now + (options.debounceMs ?? 0);
  }

  async fail(conversationId: string, options: FailOptions): Promise<void> {
    const job = this.jobs.get(conversationId);
    if (!job) return;

    // Nothing to restore: the messages were never taken out of the row.
    job.lockedAt = null;
    job.runAfter = options.retryAt;
    job.lastError = options.error;
  }

  /** Test helper: every turn recorded for a conversation, oldest first. */
  turnsFor(conversationId: string): StoredTurn[] {
    return [...this.turns.values()]
      .filter((turn) => turn.conversationId === conversationId)
      .sort((a, b) => a.at - b.at)
      .map(clone);
  }

  /** Test helper: how many jobs are outstanding. */
  jobCount(): number {
    return this.jobs.size;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
