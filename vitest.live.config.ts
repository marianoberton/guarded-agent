import { defineConfig } from "vitest/config";

/**
 * Live smoke tests. These hit the network and cost real money, so they are not
 * part of `npm test` — run them with `npm run test:live` when closing a
 * milestone.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.live.test.ts", "tests/**/*.db.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
