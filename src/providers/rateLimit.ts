/**
 * Requests-per-second limiter shared across concurrent callers.
 *
 * Ported from the Jev client that has been running against OpenRouter
 * (jevmail/jev.py). OpenRouter allows 1200 req/min; the default leaves margin
 * rather than discovering the ceiling in production.
 */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private nextSlot = 0;

  constructor(
    maxRps: number,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.minIntervalMs = maxRps > 0 ? 1000 / maxRps : 0;
  }

  /**
   * Resolves when the caller may issue its request. Slots are reserved
   * synchronously before awaiting, so concurrent callers queue behind each
   * other instead of all reading the same "now" and firing at once.
   */
  async acquire(): Promise<void> {
    if (this.minIntervalMs <= 0) return;

    const now = this.clock();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;

    if (wait > 0) await this.sleep(wait);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
