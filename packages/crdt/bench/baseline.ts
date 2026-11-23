/**
 * Baseline benchmark for the array-backed RGA (docs/06-ROADMAP.md, performance
 * baseline). Plain timing with g.performance.now(); heap measured after a forced
 * GC when node is started with --expose-gc.
 *
 * Run: pnpm bench   (from packages/crdt)
 */
import { Replica, type Op } from "../src/index";

// The package is compiled without DOM or Node types on purpose, so the few
// host globals this script needs are declared here.
const g = globalThis as unknown as {
  gc?: () => void;
  performance: { now(): number };
  console: { log(s: string): void };
  process: { version: string; memoryUsage(): { heapUsed: number } };
};

function heapMB(): number {
  g.gc?.();
  return g.process.memoryUsage().heapUsed / 1024 / 1024;
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  scenario: string;
  n: number;
  ms: number;
  heapMB: number;
}
const rows: Row[] = [];

function time(scenario: string, n: number, fn: () => Replica | void): void {
  const before = heapMB();
  const t0 = g.performance.now();
  const keep = fn();
  const ms = g.performance.now() - t0;
  const after = heapMB();
  rows.push({ scenario, n, ms, heapMB: after - before });
  void keep;
}

const sizes = [1_000, 10_000, 100_000];
// Quadratic scenarios are capped so the run finishes in reasonable time.
const quadraticSizes = [1_000, 10_000, 30_000];

for (const n of sizes) {
  time("one paste of n chars (chain of inserts)", n, () => {
    const r = new Replica("a");
    r.localInsert(0, "x".repeat(n));
    return r;
  });
}

for (const n of quadraticSizes) {
  time("type n chars one by one at the end", n, () => {
    const r = new Replica("a");
    for (let i = 0; i < n; i++) r.localInsert(i, "x");
    return r;
  });
}

for (const n of quadraticSizes) {
  time("n random single-char inserts", n, () => {
    const rand = prng(1);
    const r = new Replica("a");
    for (let i = 0; i < n; i++) r.localInsert(Math.floor(rand() * (i + 1)), "x");
    return r;
  });
}

for (const n of quadraticSizes) {
  time("n random single-char deletes (after n inserts, not timed separately)", n, () => {
    const rand = prng(2);
    const r = new Replica("a");
    r.localInsert(0, "x".repeat(n));
    for (let i = 0; i < n; i++) r.localDelete(Math.floor(rand() * (n - i)), 1);
    return r;
  });
}

for (const n of quadraticSizes) {
  const src = new Replica("src");
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) ops.push(...src.localInsert(i, "x"));
  time("apply n remote inserts one op at a time (in order)", n, () => {
    const r = new Replica("b");
    for (const op of ops) r.applyRemote([op]);
    return r;
  });
}

g.console.log(JSON.stringify({ node: g.process.version, rows }, null, 2));
