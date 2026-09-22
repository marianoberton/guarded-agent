export const DEFAULT_WINDOW_HOURS = 24;

export interface WindowState {
  open: boolean;
  /** When the window shuts. Null when the customer has never written. */
  closesAt: number | null;
  /** Milliseconds left, 0 once shut. */
  remainingMs: number;
}

/**
 * The WhatsApp customer service window.
 *
 * Measured from the customer's last message, per conversation. Inside it the
 * business may reply freely; outside it only an approved template may be sent.
 *
 * This is enforced by the runtime rather than asked of the prompt, because a
 * model that has been told about a deadline is not a mechanism — it is a
 * suggestion that fails silently at 24 hours and one minute.
 */
export function windowState(
  lastCustomerMessageAt: number | null,
  now: number,
  windowMs: number = DEFAULT_WINDOW_HOURS * 60 * 60 * 1000,
): WindowState {
  // No inbound message ever means no window was opened — a business cannot
  // start a free-form conversation on WhatsApp.
  if (lastCustomerMessageAt === null) return { open: false, closesAt: null, remainingMs: 0 };

  const closesAt = lastCustomerMessageAt + windowMs;
  const remainingMs = Math.max(0, closesAt - now);
  return { open: remainingMs > 0, closesAt, remainingMs };
}

export function isWindowOpen(
  lastCustomerMessageAt: number | null,
  now: number,
  windowMs?: number,
): boolean {
  return windowState(lastCustomerMessageAt, now, windowMs).open;
}

export function hoursToMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}
