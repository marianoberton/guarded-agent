import "dotenv/config";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresStore } from "../../src/stores/postgres/store.js";
import { createWorker } from "../../src/core/worker.js";
import { emptyConversation } from "../../src/core/turn.js";
import { completion, deps, stubLlm } from "../helpers.js";

/**
 * Integration test against a real Postgres.
 *
 *   npm run db:up && npm run test:db
 *
 * MemoryStore implements the same queue contract and the unit tests cover the
 * worker, but only this can show that the SQL is correct under real
 * concurrency. `FOR UPDATE SKIP LOCKED` cannot be proven in a single process.
 */

const url =
  process.env["DATABASE_URL"] ?? "postgres://guarded:guarded@localhost:54329/guarded_agent";

/**
 * Reachability is decided at module load, not in beforeAll.
 *
 * `describe` bodies run during collection, before any hook — a gate computed
 * in beforeAll is still false when `it` vs `it.skip` is chosen, so every test
 * silently skips even with a database right there.
 */
const pool = new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 2000 });
let reachable = false;
try {
  await pool.query("select 1");
  await new PostgresStore(pool).migrate();
  reachable = true;
} catch {
  reachable = false;
}

const db = reachable ? it : it.skip;

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (reachable) await pool.query("truncate conversations, messages, jobs, turns cascade");
});

function store(): PostgresStore {
  return new PostgresStore(pool);
}

describe("PostgresStore", () => {
  db("round-trips a conversation with its messages", async () => {
    const s = store();
    await s.save({
      ...emptyConversation("c1"),
      status: "human",
      lastCustomerMessageAt: 1234,
      turnsWithoutProgress: 2,
      messages: [
        { role: "user", text: "hola", at: 1 },
        { role: "assistant", text: "¡hola!", at: 2 },
      ],
    });

    const loaded = await s.load("c1");
    expect(loaded).toEqual({
      id: "c1",
      status: "human",
      lastCustomerMessageAt: 1234,
      turnsWithoutProgress: 2,
      messages: [
        { role: "user", text: "hola", at: 1 },
        { role: "assistant", text: "¡hola!", at: 2 },
      ],
    });
  });

  db("appends only what is new rather than rewriting history", async () => {
    const s = store();
    const first = {
      ...emptyConversation("c1"),
      messages: [{ role: "user" as const, text: "a", at: 1 }],
    };
    await s.save(first);
    await s.save({
      ...first,
      messages: [...first.messages, { role: "assistant", text: "b", at: 2 }],
    });

    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from messages where conversation_id = 'c1'",
    );
    expect(rows[0]?.count).toBe("2");
  });

  db("returns null for a conversation that does not exist", async () => {
    await expect(store().load("nope")).resolves.toBeNull();
  });

  db("round-trips a turn record with its trace", async () => {
    const s = store();
    await s.save(emptyConversation("c1"));
    await s.recordTurn({
      id: "t1",
      conversationId: "c1",
      at: 5,
      inbound: "hola",
      actions: [{ type: "send", text: "¡hola!" }],
      trace: [{ step: "respond", by: "llm", outcome: "end", latencyMs: 12 }],
    });

    const turn = await s.getTurn("t1");
    expect(turn).toMatchObject({
      id: "t1",
      at: 5,
      actions: [{ type: "send", text: "¡hola!" }],
    });
    expect(turn?.trace[0]).toMatchObject({ by: "llm", outcome: "end" });
  });
});

describe("the Postgres queue", () => {
  db("keeps one row per conversation however many messages arrive", async () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      await s.enqueue({ conversationId: "c1", text: `m${i}`, at: i }, { now: 0 });
    }

    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from jobs",
    );
    expect(rows[0]?.count).toBe("1");

    const job = await s.dequeue({ now: 1 });
    expect(job?.pending).toHaveLength(5);
  });

  db("does not hand the same job to a second caller", async () => {
    const s = store();
    await s.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });

    expect(await s.dequeue({ now: 1 })).not.toBeNull();
    expect(await s.dequeue({ now: 2 })).toBeNull();
  });

  db("reclaims a dead worker's job with its messages intact", async () => {
    const s = store();
    await s.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });
    await s.dequeue({ now: 1, lockTimeoutMs: 1000 });

    expect(await s.dequeue({ now: 500, lockTimeoutMs: 1000 })).toBeNull();
    const reclaimed = await s.dequeue({ now: 5000, lockTimeoutMs: 1000 });
    expect(reclaimed?.pending.map((p) => p.text)).toEqual(["a"]);
  });

  db("removes only the messages the turn handled", async () => {
    const s = store();
    await s.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });
    const job = await s.dequeue({ now: 1 });
    await s.enqueue({ conversationId: "c1", text: "b", at: 2 }, { now: 2 });

    await s.complete("c1", { now: 3, processed: job?.pending.length ?? 0 });

    const next = await s.dequeue({ now: 4 });
    expect(next?.pending.map((p) => p.text)).toEqual(["b"]);
  });

  db("deletes the job once everything is handled", async () => {
    const s = store();
    await s.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });
    const job = await s.dequeue({ now: 1 });
    await s.complete("c1", { now: 2, processed: job?.pending.length ?? 0 });

    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from jobs",
    );
    expect(rows[0]?.count).toBe("0");
  });

  db("pushes the scheduled run forward with each new message", async () => {
    const s = store();
    await s.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0, debounceMs: 30_000 });
    expect(await s.dequeue({ now: 20_000 })).toBeNull();

    await s.enqueue(
      { conversationId: "c1", text: "b", at: 20_000 },
      { now: 20_000, debounceMs: 30_000 },
    );
    expect(await s.dequeue({ now: 40_000 })).toBeNull();
    expect(await s.dequeue({ now: 50_001 })).not.toBeNull();
  });
});

describe("two workers, 100 jobs", () => {
  db(
    "process every conversation exactly once",
    async () => {
      // The M4 promise. SKIP LOCKED is the whole reason this can be asserted,
      // and it cannot be proven in a single process against MemoryStore.
      const s = store();
      const total = 100;

      for (let i = 0; i < total; i++) {
        await s.enqueue({ conversationId: `c${i}`, text: `hola ${i}`, at: i }, { now: 0 });
      }

      let ids = 0;
      const makeWorker = (): ReturnType<typeof createWorker> =>
        createWorker({
          store: s,
          deps: () => deps({ llm: stubLlm([completion({ text: "ok" })]).fn, tools: [] }),
          now: () => Date.now(),
          newId: () => `turn-${++ids}`,
          pollIntervalMs: 1,
          sleep: async () => undefined,
        });

      const a = makeWorker();
      const b = makeWorker();

      // Drain rather than polling forever: each runOnce claims at most one job.
      const drain = async (worker: ReturnType<typeof createWorker>): Promise<number> => {
        let done = 0;
        while (await worker.runOnce()) done++;
        return done;
      };

      const [doneA, doneB] = await Promise.all([drain(a), drain(b)]);

      expect(doneA + doneB).toBe(total);
      // Both workers actually took part, otherwise this proves nothing.
      expect(Math.min(doneA, doneB)).toBeGreaterThan(0);

      const { rows: jobs } = await pool.query<{ count: string }>(
        "select count(*)::text as count from jobs",
      );
      expect(jobs[0]?.count).toBe("0");

      // Exactly one turn per conversation: no double processing.
      const { rows: turns } = await pool.query<{
        count: string;
        conversations: string;
      }>(
        `select count(*)::text as count,
                count(distinct conversation_id)::text as conversations
           from turns`,
      );
      expect(turns[0]).toEqual({ count: String(total), conversations: String(total) });
    },
    30_000,
  );
});
