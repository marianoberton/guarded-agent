import { z } from "zod";
import { defineTool } from "../../src/index.js";
import { STOCK } from "./stock.js";

/**
 * Tools-return-prompt: each one returns text that becomes the next prompt
 * segment. Writes would go through store functions here — the model never
 * touches state directly.
 */

export const lookupStock = defineTool({
  name: "lookupStock",
  description: "Search the dealership's available cars by model, year or transmission.",
  schema: z.object({
    model: z.string().optional().describe("Model name, e.g. Corolla"),
    year: z.number().int().optional().describe("Exact model year"),
    transmission: z.enum(["manual", "automatic"]).optional(),
  }),
  run: (args) => {
    const matches = STOCK.filter(
      (car) =>
        (!args.model || car.model.toLowerCase().includes(args.model.toLowerCase())) &&
        (!args.year || car.year === args.year) &&
        (!args.transmission || car.transmission === args.transmission),
    );

    if (matches.length === 0) return "No cars in stock match that search.";

    return [
      `${matches.length} car(s) in stock:`,
      ...matches.map(
        (car) =>
          `- ${car.id}: ${car.model} ${car.year}, ${car.transmission}, ${car.colour}, USD ${car.priceUsd.toLocaleString("en-US")}`,
      ),
    ].join("\n");
  },
});

export const bookVisit = defineTool({
  name: "bookVisit",
  description: "Book a showroom visit for a customer to see a specific car.",
  sideEffecting: true,
  schema: z.object({
    carId: z.string().describe("Stock id, e.g. A-1"),
    date: z.string().describe("ISO date, e.g. 2026-10-03"),
    customerName: z.string(),
  }),
  run: (args, ctx) => {
    const car = STOCK.find((c) => c.id === args.carId);
    if (!car) return `No car with id "${args.carId}". Look up the stock first.`;
    // A real implementation writes through a store function passed in deps.
    return `Visit booked: ${args.customerName} sees ${car.model} ${car.year} (${car.id}) on ${args.date}. Reference ${ctx.conversationId}.`;
  },
});

export const sendQuote = defineTool({
  name: "sendQuote",
  description: "Send a formal written quote for a car, optionally with a discount.",
  sideEffecting: true,
  schema: z.object({
    carId: z.string(),
    discountPct: z.number().min(0).max(100).default(0),
  }),
  run: (args) => {
    const car = STOCK.find((c) => c.id === args.carId);
    if (!car) return `No car with id "${args.carId}".`;
    const final = Math.round(car.priceUsd * (1 - args.discountPct / 100));
    return `Quote sent for ${car.model} ${car.year} (${car.id}): USD ${final.toLocaleString("en-US")} with ${args.discountPct}% off.`;
  },
});

export const DEALERSHIP_TOOLS = [lookupStock, bookVisit, sendQuote];

export const SYSTEM_PROMPT = [
  "You are the sales assistant for a used-car dealership.",
  "Answer only from the stock returned by lookupStock. Never invent cars, availability or prices.",
  "Be brief and concrete. Reply in the customer's language.",
].join(" ");
