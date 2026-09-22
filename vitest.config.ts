import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Live smoke tests are opt-in: they need OPENROUTER_API_KEY and hit the network.
    exclude: ["tests/**/*.live.test.ts", "tests/**/*.db.test.ts", "node_modules/**"],
    environment: "node",
  },
});
