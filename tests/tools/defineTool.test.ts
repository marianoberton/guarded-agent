import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, ToolInputError, toInputSchema } from "../../src/tools/defineTool.js";

const ctx = { conversationId: "c1", now: () => 0 };

describe("toInputSchema", () => {
  it("emits an object schema that rejects unknown keys", () => {
    const schema = toInputSchema(
      z.object({ model: z.string(), year: z.number().int().optional() }),
    );

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["model"],
    });
    // $schema is not accepted by either provider's tool definition.
    expect(schema).not.toHaveProperty("$schema");
  });

  it("carries descriptions through to the model", () => {
    const schema = toInputSchema(z.object({ model: z.string().describe("Model name") })) as {
      properties: { model: { description: string } };
    };

    expect(schema.properties.model.description).toBe("Model name");
  });
});

describe("defineTool", () => {
  const search = defineTool({
    name: "search",
    description: "Search stock.",
    schema: z.object({ model: z.string(), year: z.number().int().optional() }),
    run: (args) => `searched ${args.model}${args.year ? ` ${args.year}` : ""}`,
  });

  it("validates arguments with zod before running", async () => {
    await expect(search.execute({ model: "Corolla", year: 2022 }, ctx)).resolves.toBe(
      "searched Corolla 2022",
    );
  });

  it("rejects arguments that do not match the schema", async () => {
    await expect(search.execute({ model: 42 }, ctx)).rejects.toThrow(ToolInputError);
  });

  it("names the offending field so the model can correct itself", async () => {
    // The error text is handed back to the model as a tool result, so it has to
    // say what was actually wrong.
    await expect(search.execute({}, ctx)).rejects.toThrow(/model/);
  });

  it("defaults to not side-effecting, so riskGate ignores read-only tools", () => {
    expect(search.sideEffecting).toBe(false);
    const writer = defineTool({
      name: "book",
      description: "Book something.",
      sideEffecting: true,
      schema: z.object({}),
      run: () => "booked",
    });
    expect(writer.sideEffecting).toBe(true);
  });

  it("marks strict only when asked, since strict mode forbids optional fields", () => {
    expect(search.spec.strict).toBeUndefined();
    const strict = defineTool({
      name: "strict",
      description: "Strict tool.",
      strict: true,
      schema: z.object({ a: z.string() }),
      run: () => "ok",
    });
    expect(strict.spec.strict).toBe(true);
  });

  it("applies zod defaults before handing arguments to run", async () => {
    const quote = defineTool({
      name: "quote",
      description: "Quote a car.",
      schema: z.object({ carId: z.string(), discountPct: z.number().default(0) }),
      run: (args) => `discount ${args.discountPct}`,
    });

    await expect(quote.execute({ carId: "A-1" }, ctx)).resolves.toBe("discount 0");
  });
});
