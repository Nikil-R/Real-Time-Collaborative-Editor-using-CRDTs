/**
 * Own CRDT versus Yjs on the same synthetic editing trace (docs/07-TESTING.md
 * section 8). Yjs is a devDependency used ONLY here; the CRDT package itself has
 * no runtime dependency.
 *
 * The trace is generated from a fixed seed: mostly typing at a moving cursor,
 * with backspaces, cursor jumps, pastes and range deletes. Every result is
 * checked against a plain-string model, so a wrong merge cannot hide as a
 * fast one.
 *
 * Run: pnpm bench:yjs  (from packages/crdt)
 */
import * as Y from "yjs";
import { Replica, toWire, type Op } from "../src/index";

const g = globalThis as unknown as {
  gc?: () => void;
  performance: { now(): number };
  console: { log(s: string): void };
  process: { version: string; memoryUsage(): { heapUsed: number } };
};

type Edit = { at: number; del: number; ins: string };

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

const ALPHABET = "abcdefghijklmnopqrstuvwxyz      \n";

/** Seeded trace of single-user edits plus the text it must produce. */
function makeTrace(edits: number, seed: number): { trace: Edit[]; text: string } {
  const rand = prng(seed);
  const trace: Edit[] = [];
  let model = "";
  let cursor = 0;
  const pick = (n: number) => Math.floor(rand() * n);
  while (trace.length < edits) {
    const r = rand();
    let e: Edit | null = null;
    if (r < 0.7) {
      e = { at: cursor, del: 0, ins: ALPHABET[pick(ALPHABET.length)]! };
      cursor += 1;
    } else if (r < 0.82 && cursor > 0) {
      e = { at: cursor - 1, del: 1, ins: "" };
      cursor -= 1;
    } else if (r < 0.9) {
      cursor = pick(model.length + 1); // jump somewhere else
    } else if (r < 0.95) {
      cursor = Math.max(0, Math.min(model.length, cursor + pick(11) - 5));
    } else if (r < 0.98) {
      const len = 5 + pick(36);
      const text = Array.from({ length: len }, () => ALPHABET[pick(ALPHABET.length)]!).join("");
      e = { at: cursor, del: 0, ins: text };
      cursor += len;
    } else if (model.length - cursor > 2) {
      const len = Math.min(2 + pick(19), model.length - cursor);
      e = { at: cursor, del: len, ins: "" };
    }
    if (!e) continue;
    model = model.slice(0, e.at) + e.ins + model.slice(e.at + e.del);
    trace.push(e);
  }
  return { trace, text: model };
}

function heapMB(): number {
  g.gc?.();
  g.gc?.();
  return g.process.memoryUsage().heapUsed / 1024 / 1024;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
const ms = (t0: number) => g.performance.now() - t0;

interface Row {
  edits: number;
  finalChars: number;
  own: {
    applyLocalMs: number;
    replayRemoteMs: number;
    opsJsonBytes: number;
    stateJsonBytes: number;
    heapMB: number;
    textMatches: boolean;
  };
  yjs: {
    applyLocalMs: number;
    replayIncrementalMs: number;
    replayMergedMs: number;
    mergedUpdateBytes: number;
    incrementalUpdatesBytes: number;
    heapMB: number;
    textMatches: boolean;
  };
}

function runOne(edits: number, seed: number): Row {
  const { trace, text } = makeTrace(edits, seed);

  // ---- own CRDT --------------------------------------------------------
  const ownBefore = heapMB();
  const replica = new Replica("a");
  const ops: Op[] = [];
  let t0 = g.performance.now();
  for (const e of trace) {
    if (e.del) ops.push(...replica.localDelete(e.at, e.del));
    if (e.ins) ops.push(...replica.localInsert(e.at, e.ins));
  }
  const ownLocalMs = ms(t0);
  const ownHeap = heapMB() - ownBefore;
  const opsJson = JSON.stringify(ops.map((op, i) => toWire(op, { r: "a", n: i + 1 })));
  const stateJson = JSON.stringify(replica.getState());

  const remote = new Replica("b");
  t0 = g.performance.now();
  remote.applyRemote(ops);
  const ownReplayMs = ms(t0);
  const ownMatches = replica.getText() === text && remote.getText() === text;

  // ---- Yjs -----------------------------------------------------------------
  const yBefore = heapMB();
  const doc = new Y.Doc();
  const ytext = doc.getText("t");
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  t0 = g.performance.now();
  for (const e of trace) {
    doc.transact(() => {
      if (e.del) ytext.delete(e.at, e.del);
      if (e.ins) ytext.insert(e.at, e.ins);
    });
  }
  const yLocalMs = ms(t0);
  const yHeap = heapMB() - yBefore;

  const merged = Y.encodeStateAsUpdate(doc);
  const fresh1 = new Y.Doc();
  t0 = g.performance.now();
  Y.applyUpdate(fresh1, merged);
  const yMergedMs = ms(t0);

  const fresh2 = new Y.Doc();
  t0 = g.performance.now();
  for (const u of updates) Y.applyUpdate(fresh2, u);
  const yIncMs = ms(t0);
  const yMatches =
    ytext.toString() === text &&
    fresh1.getText("t").toString() === text &&
    fresh2.getText("t").toString() === text;

  return {
    edits,
    finalChars: text.length,
    own: {
      applyLocalMs: ownLocalMs,
      replayRemoteMs: ownReplayMs,
      opsJsonBytes: bytes(opsJson),
      stateJsonBytes: bytes(stateJson),
      heapMB: ownHeap,
      textMatches: ownMatches,
    },
    yjs: {
      applyLocalMs: yLocalMs,
      replayIncrementalMs: yIncMs,
      replayMergedMs: yMergedMs,
      mergedUpdateBytes: merged.length,
      incrementalUpdatesBytes: updates.reduce((n, u) => n + u.length, 0),
      heapMB: yHeap,
      textMatches: yMatches,
    },
  };
}

const sizes = (g.process as unknown as { argv: string[] }).argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const rows = (sizes.length ? sizes : [10_000, 50_000]).map((n) => runOne(n, 42));
g.console.log(JSON.stringify({ node: g.process.version, yjs: "see package.json", seed: 42, rows }, null, 2));
