import { DEFAULT_WINDOW_HOURS, hoursToMs, windowState } from "./window.js";
import type { Channel, PlanInput, SendPlan } from "../types.js";

export { DEFAULT_WINDOW_HOURS, hoursToMs, isWindowOpen, windowState } from "./window.js";
export type { WindowState } from "./window.js";

export interface WhatsAppTemplates {
  /** Approved template used to reopen a conversation whose window has shut. */
  reopen?: string;
}

export interface WhatsAppChannelOptions {
  windowHours?: number;
  templates?: WhatsAppTemplates;
}

/**
 * WhatsApp, with its customer service window enforced by the runtime.
 *
 * Inside the window the agent replies freely. Outside it, the reply cannot be
 * delivered: with a reopen template configured the conversation moves to
 * `awaiting_reopen` and the template goes out instead; without one the message
 * is deferred and the text is handed back rather than dropped.
 */
export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp";

  private readonly windowMs: number;
  private readonly templates: WhatsAppTemplates;

  constructor(options: WhatsAppChannelOptions = {}) {
    this.windowMs = hoursToMs(options.windowHours ?? DEFAULT_WINDOW_HOURS);
    this.templates = options.templates ?? {};
  }

  plan({ state, text, now }: PlanInput): SendPlan {
    const window = windowState(state.lastCustomerMessageAt, now, this.windowMs);
    if (window.open) return { type: "free_form", text };

    const reason =
      state.lastCustomerMessageAt === null
        ? "window_never_opened"
        : `window_closed_at:${window.closesAt}`;

    const reopen = this.templates.reopen;
    return reopen
      ? { type: "template", template: reopen, pendingText: text, reason }
      : { type: "deferred", pendingText: text, reason };
  }
}
