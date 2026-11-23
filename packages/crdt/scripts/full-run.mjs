// Runs the CRDT test suite with a large number of random schedules per property.
// Usage: node scripts/full-run.mjs [runs]   (default 10000)
import { spawnSync } from "node:child_process";

const runs = process.argv[2] ?? "10000";
const started = Date.now();
const result = spawnSync("pnpm", ["exec", "vitest", "run"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, FC_RUNS: runs },
});
console.log(`\nFC_RUNS=${runs} finished in ${((Date.now() - started) / 1000).toFixed(1)}s, exit ${result.status}`);
process.exit(result.status ?? 1);
