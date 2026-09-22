import type { Decider, TraceEntry } from "./types.js";
import type { Usage } from "../providers/types.js";

/**
 * Trace entries are appended as each step completes, never assembled at the end.
 * If the turn throws halfway through, everything decided up to that point is
 * still on the record — which is the difference between a debuggable failure
 * and a shrug.
 */
export class TraceBuilder {
  private readonly entries: TraceEntry[] = [];

  constructor(private readonly now: () => number) {}

  /** Times `fn` on the injected clock and records the outcome it reports. */
  async step<T>(
    step: string,
    by: Decider,
    fn: () => Promise<T> | T,
    describe: (value: T) => {
      outcome: string;
      detail?: Record<string, unknown>;
      usage?: Usage;
      costUsd?: number;
    },
  ): Promise<T> {
    const startedAt = this.now();
    try {
      const value = await fn();
      const { outcome, detail, usage, costUsd } = describe(value);
      this.entries.push({
        step,
        by,
        outcome,
        ...(detail ? { detail } : {}),
        latencyMs: this.now() - startedAt,
        ...(usage ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
      return value;
    } catch (error) {
      this.entries.push({
        step,
        by,
        outcome: "error",
        detail: { message: error instanceof Error ? error.message : String(error) },
        latencyMs: this.now() - startedAt,
      });
      throw error;
    }
  }

  /** Records a decision that took no measurable work (a gate, a verdict). */
  note(
    step: string,
    by: Decider,
    outcome: string,
    detail?: Record<string, unknown>,
    latencyMs = 0,
  ): void {
    this.entries.push({ step, by, outcome, ...(detail ? { detail } : {}), latencyMs });
  }

  build(): TraceEntry[] {
    return [...this.entries];
  }
}
