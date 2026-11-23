import { defineConfig } from "vitest/config";

// Property tests can run 10,000+ random schedules each, so the default 5 s
// per-test timeout is too short for the full runs.
export default defineConfig({
  test: {
    testTimeout: 30 * 60 * 1000,
    include: ["test/**/*.test.ts"],
  },
});
