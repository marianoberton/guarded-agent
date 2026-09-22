import { jev } from "../../src/index.js";
import type { QuestionMap } from "../../src/index.js";

/**
 * The bounded forks of a sales conversation.
 *
 * These are the decisions that have a small, knowable answer space — which is
 * exactly where a System One model belongs and a chat model is overkill. The
 * criteria are the only real quality lever here, so they are worth writing
 * carefully.
 */
export const DEALERSHIP_QUESTIONS: QuestionMap = {
  intent: jev.choice("What does the customer want?", {
    stock_question: "Availability, models, versions, colours.",
    price_question: "Asks a price or a quote for a specific car.",
    price_negotiation: "Pushes for a discount or a lower price.",
    visit: "Wants to see or test drive a car.",
    asks_for_human: "Explicitly wants to talk to a person.",
    other: "None of these.",
  }),

  language: jev.choice("What language is the message written in?", {
    es: "Spanish",
    en: "English",
    pt: "Portuguese",
  }),

  needs_human: jev.noul("Should a human take this conversation now?", {
    true:
      "The customer is angry, asking for a person, negotiating terms, or raising " +
      "something with legal or financial consequences.",
    false: "A routine question the assistant can answer from stock information.",
  }),
};
