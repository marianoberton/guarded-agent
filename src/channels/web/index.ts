import type { Channel, PlanInput, SendPlan } from "../types.js";

/**
 * A transport with no window: the page is open, the message goes out.
 *
 * It exists mostly to prove the Channel seam is real. If the only channel were
 * WhatsApp, the window would have quietly become part of the core instead of a
 * property of one transport.
 */
export class WebChannel implements Channel {
  readonly name = "web";

  plan({ text }: PlanInput): SendPlan {
    return { type: "free_form", text };
  }
}
