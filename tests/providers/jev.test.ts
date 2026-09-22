import { afterEach, describe, expect, it, vi } from "vitest";
import { JevProvider } from "../../src/providers/jev.js";
import { RateLimiter } from "../../src/providers/rateLimit.js";
import { ProviderError } from "../../src/providers/types.js";
import { choice, noul, score } from "../../src/jev/questions.js";
import type { QuestionMap } from "../../src/classify/types.js";

const questions: QuestionMap = {
  intent: choice("What does the customer want?", { stock: "Availability", other: null }),
  needs_human: noul("Should a human take this now?"),
  urgency: score("How urgent?", ["None", "Some", "High"]),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JevProvider payload", () => {
  it("sends the question map verbatim as the wire format", () => {
    // Question objects ARE the wire format. If this ever needs translating,
    // JevClassifier has stopped being a pass-through and the two classifiers
    // have drifted apart.
    const jev = new JevProvider({ apiKey: "k" });
    const payload = jev.payload({ inbound: "hola" }, questions);

    expect(payload).toEqual({
      model: "typesafe/jev-1.13",
      state: { inbound: "hola" },
      questions,
      zdr: true,
    });
    expect(payload["questions"]).toBe(questions);
  });

  it("keeps zero-data-retention routing on unless explicitly disabled", () => {
    // This endpoint sees customer conversations; opting out has to be deliberate.
    expect(new JevProvider({ apiKey: "k" }).payload({}, {})).toHaveProperty("zdr", true);
    expect(new JevProvider({ apiKey: "k", zdr: false }).payload({}, {})).not.toHaveProperty("zdr");
  });

  it("targets OpenRouter's decisions endpoint, not the chat one", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answers: {}, usage: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await new JevProvider({ apiKey: "secret", maxRps: 0 }).decide({}, {});

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer secret");
  });
});

describe("JevProvider.decide", () => {
  it("returns the answers map and accumulates usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          answers: {
            intent: { type: "choice", choice: "stock", probabilities: { stock: 0.94 }, confidence: 0.94 },
            needs_human: { type: "noul", noul: 0.07 },
          },
          usage: { input_tokens: 1400, output_tokens: 0 },
        }),
      ),
    );

    const jev = new JevProvider({ apiKey: "k", maxRps: 0 });
    const answers = await jev.decide({ inbound: "corolla?" }, questions);

    expect(answers["intent"]).toMatchObject({ choice: "stock", confidence: 0.94 });
    expect(jev.usage).toEqual({ inputTokens: 1400, outputTokens: 0, requests: 1 });
  });

  it("prices input only, because Jev does not bill output tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ answers: {}, usage: { input_tokens: 1_000_000, output_tokens: 500_000 } }),
      ),
    );

    const jev = new JevProvider({ apiKey: "k", maxRps: 0 });
    await jev.decide({}, {});

    expect(jev.costUsd()).toBeCloseTo(0.042, 6);
  });

  it("rejects a response with no answers rather than returning an empty map", async () => {
    // Silently returning {} would make every policy read 0 and quietly do
    // nothing, which is far worse than a loud failure.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad model" })));

    await expect(new JevProvider({ apiKey: "k", maxRps: 0 }).decide({}, {})).rejects.toThrow(
      ProviderError,
    );
  });

  it("retries a 429 and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ answers: { a: { type: "noul", noul: 1 } } }));
    vi.stubGlobal("fetch", fetchMock);

    const answers = await new JevProvider({
      apiKey: "k",
      maxRps: 0,
      sleep: async () => undefined,
      random: () => 0,
    }).decide({}, {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(answers["a"]).toMatchObject({ noul: 1 });
  });

  it("fails fast on a 401 instead of retrying a bad key five times", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new JevProvider({ apiKey: "bad", maxRps: 0, sleep: async () => undefined }).decide({}, {}),
    ).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("RateLimiter", () => {
  it("spaces requests by the configured interval", async () => {
    const waits: number[] = [];
    let clock = 0;
    const limiter = new RateLimiter(
      10, // 100ms apart
      async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      () => clock,
    );

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(waits).toEqual([100, 100]);
  });

  it("reserves slots synchronously so concurrent callers queue instead of colliding", async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(
      10,
      async (ms) => {
        waits.push(ms);
      },
      () => 0,
    );

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    // Every caller reads the same clock; without synchronous reservation they
    // would all compute a zero wait and fire at once.
    expect(waits).toEqual([100, 200]);
  });

  it("does not throttle at all when the limit is disabled", async () => {
    const sleep = vi.fn();
    const limiter = new RateLimiter(0, sleep, () => 0);
    await limiter.acquire();
    await limiter.acquire();
    expect(sleep).not.toHaveBeenCalled();
  });
});
