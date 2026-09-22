import { z } from "zod";
import type { ToolSpec } from "../providers/types.js";

export interface ToolContext {
  conversationId: string;
  now: () => number;
}

/** Thrown when the model's arguments do not satisfy the tool's zod schema. */
export class ToolInputError extends Error {
  constructor(
    readonly toolName: string,
    readonly issues: string,
  ) {
    super(`Invalid arguments for "${toolName}": ${issues}`);
    this.name = "ToolInputError";
  }
}

/**
 * A tool, with its schema erased.
 *
 * Erasing the generic at the boundary keeps the tool registry a plain
 * `readonly Tool[]` instead of a variance puzzle, and forces every call site
 * through `execute`, which validates before running.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  /**
   * Does this tool change the world? riskGate (M2) only inspects the ones that
   * do — there is no point asking Jev whether reading the stock list is risky.
   */
  readonly sideEffecting: boolean;
  readonly spec: ToolSpec;
  execute(rawArgs: unknown, ctx: ToolContext): Promise<string>;
}

export interface ToolDefinition<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  sideEffecting?: boolean;
  /**
   * Opt-in. Strict mode requires every property to be required, so a tool with
   * optional inputs cannot use it. Arguments are zod-validated on receipt
   * regardless, which catches strictly more than the provider's own check.
   */
  strict?: boolean;
  /**
   * Tools-return-prompt: whatever this returns becomes the next prompt segment.
   * Writes go through store functions here; the model never touches state.
   */
  run: (args: z.output<S>, ctx: ToolContext) => Promise<string> | string;
}

/** zod schema -> JSON Schema the providers accept. */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json["$schema"];
  // Both Anthropic and OpenAI reject unknown keys only when told to.
  if (json["type"] === "object") json["additionalProperties"] = false;
  return json;
}

export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): Tool {
  const spec: ToolSpec = {
    name: def.name,
    description: def.description,
    inputSchema: toInputSchema(def.schema),
    ...(def.strict ? { strict: true } : {}),
  };

  return {
    name: def.name,
    description: def.description,
    sideEffecting: def.sideEffecting ?? false,
    spec,
    async execute(rawArgs, ctx) {
      const parsed = def.schema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new ToolInputError(
          def.name,
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        );
      }
      return def.run(parsed.data as z.output<S>, ctx);
    },
  };
}
