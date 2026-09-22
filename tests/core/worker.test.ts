import { describe, expect, it, vi } from "vitest";
import { coalesce, createWorker } from "../../src/core/worker.js";
import { MemoryStore } from "../../src/stores/memory.js";
import { emptyConversation } from "../../src/core/turn.js";
import type { Action } from "../../src/core/types.js";
import { completion, deps, stubLlm } from "../helpers.js";

function workerOver(
  store: MemoryStore,
  replies: string[],
  overrides: Partial<Parameters<typeof createWorker>[0]> = {},
): ReturnType<typeof createWorker> {
  let tick = 10_000;
  const delivered: Action[] = [];
  const worker = createWorker({
    store,
    deps: () => deps({ llm: stubLlm(replies.map((text) => completion({ text }))).fn, tools: [] }),
    deliver: (action) => {
      delivered.push(action);
    },
    now: () => tick++,
    newId: () => `turn-${tick}`,
    ...overrides,
  });
  (worker as unknown as { delivered: Action[] }).delivered = delivered;
  return worker;
}

describe("coalesce", () => {
  it("turns a run of messages into one inbound", () => {
    // Four messages in a row are one turn, not four.
    expect(
      coalesce({
        conversationId: "c1",
        pending: [
          { text: "hola", at: 1 },
          { text: "tienen corolla?", at: 2 },
          { text: "automático", at: 3 },
        ],
        attempts: 1,
      }),
    ).toEqual({ conversationId: "c1", text: "hola\ntienen corolla?\nautomático", at: 3 });
  });

  it("stamps it with the last message's time, which is what the window measures", () => {
    const inbound = coalesce({
      conversationId: "c1",
      pending: [
        { text: "a", at: 100 },
        { text: "b", at: 900 },
      ],
      attempts: 1,
    });
    expect(inbound.at).toBe(900);
  });
});

describe("the queue", () => {
  it("keeps one job per conversation no matter how many messages arrive", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ conversationId: "c1", text: `m${i}`, at: i }, { now: 0 });
    }
    expect(store.jobCount()).toBe(1);
  });

  it("pushes the scheduled run forward with each new message", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0, debounceMs: 30_000 });

    // Not due yet.
    expect(await store.dequeue({ now: 20_000 })).toBeNull();

    // A second message resets the wait.
    await store.enqueue(
      { conversationId: "c1", text: "b", at: 20_000 },
      { now: 20_000, debounceMs: 30_000 },
    );
    expect(await store.dequeue({ now: 40_000 })).toBeNull();

    const job = await store.dequeue({ now: 50_001 });
    expect(job?.pending.map((p) => p.text)).toEqual(["a", "b"]);
  });

  it("does not hand the same job to a second caller", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });

    expect(await store.dequeue({ now: 1 })).not.toBeNull();
    expect(await store.dequeue({ now: 2 })).toBeNull();
  });

  it("reclaims a dead worker's job with its messages intact", async () => {
    // A claim is a lock, not a consumption. If dequeue removed the messages,
    // a worker crashing mid-turn would lose them with no way to recover.
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });
    await store.dequeue({ now: 1, lockTimeoutMs: 1000 });

    expect(await store.dequeue({ now: 500, lockTimeoutMs: 1000 })).toBeNull();

    const reclaimed = await store.dequeue({ now: 2000, lockTimeoutMs: 1000 });
    expect(reclaimed?.pending.map((p) => p.text)).toEqual(["a"]);
  });

  it("keeps the job alive when a message lands mid-turn", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });
    await store.dequeue({ now: 1 });

    await store.enqueue({ conversationId: "c1", text: "b", at: 2 }, { now: 2 });
    await store.complete("c1", { now: 3, processed: 1 });

    // Not deleted: there is still work to do.
    const next = await store.dequeue({ now: 4 });
    expect(next?.pending.map((p) => p.text)).toEqual(["b"]);
  });

  it("leaves the messages in place when a turn fails", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });
    await store.dequeue({ now: 1 });

    await store.fail("c1", { retryAt: 100, error: "boom" });

    const retried = await store.dequeue({ now: 200 });
    expect(retried?.pending.map((p) => p.text)).toEqual(["a"]);
  });

  it("keeps the retried messages in arrival order", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "first", at: 0 }, { now: 0 });
    await store.dequeue({ now: 1 });
    await store.enqueue({ conversationId: "c1", text: "second", at: 2 }, { now: 2 });

    await store.fail("c1", { retryAt: 3, error: "boom" });

    const retried = await store.dequeue({ now: 4 });
    expect(retried?.pending.map((p) => p.text)).toEqual(["first", "second"]);
  });

  it("removes only the messages the turn actually handled", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "a", at: 0 }, { now: 0 });
    const job = await store.dequeue({ now: 1 });
    // Arrived after the claim, so it was not part of this turn.
    await store.enqueue({ conversationId: "c1", text: "b", at: 2 }, { now: 2 });

    await store.complete("c1", { now: 3, processed: job?.pending.length ?? 0 });

    const next = await store.dequeue({ now: 4 });
    expect(next?.pending.map((p) => p.text)).toEqual(["b"]);
  });
});

describe("createWorker", () => {
  it("runs a turn and clears the job", async () => {
    const store = new MemoryStore();
    await store.save(emptyConversation("c1"));
    await store.enqueue({ conversationId: "c1", text: "¿tienen Corolla?", at: 1 }, { now: 1 });

    const worker = workerOver(store, ["Sí, tenemos uno."]);
    expect(await worker.runOnce()).toBe(true);

    expect(store.jobCount()).toBe(0);
    const turns = store.turnsFor("c1");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.actions).toEqual([{ type: "send", text: "Sí, tenemos uno." }]);
  });

  it("delivers the actions the turn produced", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "hola", at: 1 }, { now: 1 });

    const worker = workerOver(store, ["¡Hola!"]);
    await worker.runOnce();

    expect((worker as unknown as { delivered: Action[] }).delivered).toEqual([
      { type: "send", text: "¡Hola!" },
    ]);
  });

  it("persists the conversation so the next turn has the history", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "hola", at: 1 }, { now: 1 });
    await workerOver(store, ["¡Hola!"]).runOnce();

    const state = await store.load("c1");
    expect(state?.messages.map((m) => m.text)).toEqual(["hola", "¡Hola!"]);
  });

  it("reports an empty queue rather than blocking", async () => {
    expect(await workerOver(new MemoryStore(), []).runOnce()).toBe(false);
  });

  it("puts the messages back and retries when a turn throws", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "hola", at: 1 }, { now: 1 });

    const errors: unknown[] = [];
    let tick = 10_000;
    const worker = createWorker({
      store,
      deps: () =>
        deps({
          llm: async () => {
            throw new Error("provider down");
          },
          tools: [],
        }),
      now: () => tick++,
      retryDelayMs: () => 0,
      onError: (error) => errors.push(error),
    });

    await worker.runOnce();
    expect(errors).toHaveLength(1);

    // Still queued, with the message intact.
    const job = await store.dequeue({ now: 20_000 });
    expect(job?.pending.map((p) => p.text)).toEqual(["hola"]);
  });

  it("gives up after maxAttempts instead of retrying forever", async () => {
    const store = new MemoryStore();
    await store.enqueue({ conversationId: "c1", text: "hola", at: 1 }, { now: 1 });

    let tick = 10_000;
    const worker = createWorker({
      store,
      deps: () =>
        deps({
          llm: async () => {
            throw new Error("provider down");
          },
          tools: [],
        }),
      now: () => tick++,
      retryDelayMs: () => 0,
      maxAttempts: 3,
      onError: () => undefined,
    });

    for (let i = 0; i < 5; i++) await worker.runOnce();
    expect(store.jobCount()).toBe(0);
  });

  it("treats a burst of messages as one turn", async () => {
    const store = new MemoryStore();
    for (const [i, text] of ["hola", "tienen corolla?", "automático"].entries()) {
      await store.enqueue({ conversationId: "c1", text, at: i }, { now: i, debounceMs: 100 });
    }

    const llm = stubLlm([completion({ text: "Sí, el A-1." })]);
    let tick = 10_000;
    await createWorker({
      store,
      deps: () => deps({ llm: llm.fn, tools: [] }),
      now: () => tick++,
      newId: () => "t1",
    }).runOnce();

    const sent = llm.requests[0]?.messages[0];
    expect(sent && "content" in sent ? sent.content : "").toBe("hola\ntienen corolla?\nautomático");
    expect(store.turnsFor("c1")).toHaveLength(1);
  });

  it("stops when told to", async () => {
    const store = new MemoryStore();
    const worker = workerOver(store, [], { sleep: async () => undefined, pollIntervalMs: 0 });

    const started = worker.start();
    worker.stop();
    await expect(started).resolves.toBeUndefined();
  });

  it("backs off instead of spinning when the store itself fails", async () => {
    // A dequeue that throws means the database is unreachable. The loop must
    // sleep on it rather than hammering a machine that is already struggling.
    const broken = {
      dequeue: async () => {
        throw new Error("database unreachable");
      },
    } as unknown as MemoryStore;

    const errors: unknown[] = [];
    // Declared before the worker so the fake sleep can stop it: a sleep that
    // resolves instantly would otherwise spin the loop in microtasks forever.
    const control: { worker?: ReturnType<typeof createWorker> } = {};
    const sleep = vi.fn(async () => {
      control.worker?.stop();
    });

    const worker = createWorker({
      store: broken,
      deps: () => deps({ llm: async () => completion(), tools: [] }),
      sleep,
      pollIntervalMs: 5,
      onError: (error) => errors.push(error),
    });

    control.worker = worker;
    await worker.start();

    expect(errors).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(5);
  });
});
