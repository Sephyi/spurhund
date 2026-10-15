import { defineConfig } from "vitest/config";

// Live tests talk to real services and cost real money. Run them on purpose: `npm run test:live`.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.ts"],
    environment: "node",
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
