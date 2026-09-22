import { ProviderError } from "./types.js";

/**
 * Status codes worth another attempt. Ported from the Jev client that has been
 * running against OpenRouter in production (jevmail/jev.py).
 */
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function backoffMs(
  attempt: number,
  retryAfter: string | null,
  random: () => number,
): number {
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds, 30) * 1000;
  }
  return Math.min(2 ** attempt, 16) * (0.5 + random()) * 1000;
}

/**
 * POSTs JSON with retries on transient failures. Non-retryable responses raise
 * immediately with the body attached — a 401 should fail loudly, not five times.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: RetryOptions = {},
): Promise<unknown> {
  const maxRetries = options.maxRetries ?? 5;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(backoffMs(attempt, null, random));
      continue;
    }

    if (RETRYABLE_STATUS.has(response.status)) {
      const text = await response.text().catch(() => "");
      lastError = new ProviderError(`HTTP ${response.status}`, response.status, text.slice(0, 300));
      await sleep(backoffMs(attempt, response.headers.get("retry-after"), random));
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(`HTTP ${response.status}`, response.status, text.slice(0, 500));
    }

    return response.json();
  }

  throw new ProviderError(`Request failed after ${maxRetries} attempts: ${lastError?.message}`);
}
