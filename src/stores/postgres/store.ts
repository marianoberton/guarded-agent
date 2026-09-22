import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationState, Inbound, Message } from "../../core/types.js";
import type {
  CompleteOptions,
  DequeueOptions,
  EnqueueOptions,
  FailOptions,
  Job,
  PendingMessage,
  Store,
  StoredTurn,
} from "../types.js";

/**
 * The slice of `pg` this store uses. Typed structurally so `pg` stays an
 * optional peer dependency — a project that only ever uses MemoryStore should
 * not have to install a database driver.
 */
export interface PgQueryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function schemaSql(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

/**
 * Postgres store and queue. Plain SQL.
 *
 * The queue is a `jobs` table keyed by conversation and claimed with
 * `FOR UPDATE SKIP LOCKED`, which is the part that makes two workers safe.
 * Everything else is bookkeeping.
 */
export class PostgresStore implements Store {
  constructor(private readonly db: PgQueryable) {}

  /** Creates the tables if they do not exist. Idempotent. */
  async migrate(): Promise<void> {
    await this.db.query(schemaSql());
  }

  async load(conversationId: string): Promise<ConversationState | null> {
    const { rows } = await this.db.query<{
      id: string;
      status: string;
      last_customer_message_at: string | null;
      turns_without_progress: number;
    }>(
      `select id, status, last_customer_message_at, turns_without_progress
         from conversations where id = $1`,
      [conversationId],
    );

    const row = rows[0];
    if (!row) return null;

    const { rows: messages } = await this.db.query<{ role: string; text: string; at: string }>(
      `select role, text, at from messages where conversation_id = $1 order by id`,
      [conversationId],
    );

    return {
      id: row.id,
      status: row.status as ConversationState["status"],
      messages: messages.map((m) => ({
        role: m.role as Message["role"],
        text: m.text,
        at: Number(m.at),
      })),
      lastCustomerMessageAt:
        row.last_customer_message_at === null ? null : Number(row.last_customer_message_at),
      turnsWithoutProgress: row.turns_without_progress,
    };
  }

  /**
   * Upserts the conversation and appends whatever messages are new.
   *
   * Messages are append-only and identified by position, so this writes the
   * tail rather than rewriting history. Rewriting would renumber ids and make
   * the turn records point at the wrong things.
   */
  async save(state: ConversationState): Promise<void> {
    await this.db.query(
      `insert into conversations (id, status, last_customer_message_at, turns_without_progress, updated_at)
            values ($1, $2, $3, $4, now())
       on conflict (id) do update
              set status = excluded.status,
                  last_customer_message_at = excluded.last_customer_message_at,
                  turns_without_progress = excluded.turns_without_progress,
                  updated_at = now()`,
      [state.id, state.status, state.lastCustomerMessageAt, state.turnsWithoutProgress],
    );

    const { rows } = await this.db.query<{ count: string }>(
      `select count(*)::text as count from messages where conversation_id = $1`,
      [state.id],
    );
    const stored = Number(rows[0]?.count ?? 0);
    const fresh = state.messages.slice(stored);
    if (fresh.length === 0) return;

    const values: unknown[] = [];
    const tuples = fresh.map((message, i) => {
      values.push(state.id, message.role, message.text, message.at);
      return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
    });

    await this.db.query(
      `insert into messages (conversation_id, role, text, at) values ${tuples.join(", ")}`,
      values,
    );
  }

  async recordTurn(turn: StoredTurn): Promise<void> {
    await this.db.query(
      `insert into turns (id, conversation_id, at, inbound, actions, trace)
            values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       on conflict (id) do nothing`,
      [
        turn.id,
        turn.conversationId,
        turn.at,
        turn.inbound,
        JSON.stringify(turn.actions),
        JSON.stringify(turn.trace),
      ],
    );
  }

  async getTurn(turnId: string): Promise<StoredTurn | null> {
    const { rows } = await this.db.query<{
      id: string;
      conversation_id: string;
      at: string;
      inbound: string;
      actions: StoredTurn["actions"];
      trace: StoredTurn["trace"];
    }>(`select * from turns where id = $1`, [turnId]);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      conversationId: row.conversation_id,
      at: Number(row.at),
      inbound: row.inbound,
      actions: row.actions,
      trace: row.trace,
    };
  }

  /**
   * One row per conversation. A second message cannot create a second job —
   * it appends to this one and pushes the scheduled run forward, which is the
   * debounce and the concurrency guarantee in the same statement.
   */
  async enqueue(inbound: Inbound, options: EnqueueOptions): Promise<void> {
    const runAfter = options.now + (options.debounceMs ?? 0);
    const message: PendingMessage = { text: inbound.text, at: inbound.at };

    await this.db.query(
      `insert into jobs (conversation_id, pending, run_after)
            values ($1, $2::jsonb, $3)
       on conflict (conversation_id) do update
              set pending = jobs.pending || excluded.pending,
                  run_after = excluded.run_after`,
      [inbound.conversationId, JSON.stringify([message]), runAfter],
    );
  }

  /**
   * Claims one due job with FOR UPDATE SKIP LOCKED — the part that makes two
   * workers safe.
   *
   * The claim is a lock, not a consumption: pending stays in the row. A worker
   * that dies mid-turn therefore loses nothing, because its lock expires and
   * the messages are still there. The price is at-least-once delivery, which
   * no queue avoids without two-phase commit.
   */
  async dequeue(options: DequeueOptions): Promise<Job | null> {
    const expiry = options.now - (options.lockTimeoutMs ?? 5 * 60_000);

    const { rows } = await this.db.query<{
      conversation_id: string;
      attempts: number;
      pending: PendingMessage[];
    }>(
      `with claimed as (
         select conversation_id
           from jobs
          where run_after <= $1
            and jsonb_array_length(pending) > 0
            and (locked_at is null or locked_at < $2)
          order by run_after
            for update skip locked
          limit 1
       )
       update jobs j
          set locked_at = $1,
              attempts  = j.attempts + 1
         from claimed c
        where j.conversation_id = c.conversation_id
       returning j.conversation_id, j.attempts, j.pending`,
      [options.now, expiry],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      conversationId: row.conversation_id,
      pending: row.pending,
      attempts: row.attempts,
    };
  }

  /**
   * Drops the handled prefix, then deletes the job only if that emptied it.
   * Anything that arrived mid-turn is still there and reschedules the job.
   */
  async complete(conversationId: string, options: CompleteOptions): Promise<void> {
    // Two statements, not one CTE. Sub-statements of a WITH cannot see each
    // other's effects on the same table, so a DELETE chained to an UPDATE of
    // `jobs` silently matches nothing and the row lingers forever.

    // Nothing arrived while the turn ran, so the job is finished.
    const { rowCount } = await this.db.query(
      `delete from jobs
        where conversation_id = $1 and jsonb_array_length(pending) <= $2`,
      [conversationId, options.processed],
    );
    if (rowCount && rowCount > 0) return;

    // Something did arrive. Drop only what was handled and run again.
    await this.db.query(
      `update jobs
          set pending = coalesce(
                (select jsonb_agg(value order by ord)
                   from jsonb_array_elements(pending) with ordinality as t(value, ord)
                  where ord > $2),
                '[]'::jsonb
              ),
              locked_at = null,
              attempts  = 0,
              run_after = $3
        where conversation_id = $1`,
      [conversationId, options.processed, options.now + (options.debounceMs ?? 0)],
    );
  }

  async fail(conversationId: string, options: FailOptions): Promise<void> {
    // Nothing to restore: the messages were never taken out of the row.
    await this.db.query(
      `update jobs
          set locked_at  = null,
              run_after  = $2,
              last_error = $3
        where conversation_id = $1`,
      [conversationId, options.retryAt, options.error],
    );
  }
}
