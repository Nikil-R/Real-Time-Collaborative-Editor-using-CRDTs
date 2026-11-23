/**
 * Multi-replica simulator used by the property tests (docs/07-TESTING.md 3.1).
 *
 * N replicas make random local edits. Every operation is queued for every other
 * replica. Random "deliver" steps hand one queued operation to one replica,
 * possibly leaving a copy in the queue (a duplicate) and in any order. At the
 * end everything still queued is delivered in a seeded random order.
 */
import fc from "fast-check";
import { Replica, idKey, type Change, type CharId, type Op } from "../src/index";

export type Step =
  | { t: "edit"; r: number; kind: "ins" | "del"; at: number; text: string; len: number }
  | { t: "deliver"; from: number; to: number; pick: number; keep: boolean };

/** Small alphabet on purpose: collisions and shared origins are what we want. */
const charArb = fc.constantFrom("a", "b", "c", "x", "y", "\n", "😀", " ");

export const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({
    t: fc.constant("edit" as const),
    r: fc.nat(5),
    kind: fc.constant("ins" as const),
    at: fc.nat(100),
    text: fc.array(charArb, { minLength: 1, maxLength: 4 }).map((a) => a.join("")),
    len: fc.constant(0),
  }) },
  { weight: 1, arbitrary: fc.record({
    t: fc.constant("edit" as const),
    r: fc.nat(5),
    kind: fc.constant("del" as const),
    at: fc.nat(100),
    text: fc.constant(""),
    len: fc.integer({ min: 1, max: 4 }),
  }) },
  { weight: 5, arbitrary: fc.record({
    t: fc.constant("deliver" as const),
    from: fc.nat(5),
    to: fc.nat(5),
    pick: fc.nat(1000),
    keep: fc.boolean(),
  }) },
);

export interface Scenario {
  replicaCount: number;
  steps: Step[];
  finalSeed: number;
}

export const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  replicaCount: fc.integer({ min: 2, max: 6 }),
  steps: fc.array(stepArb, { maxLength: 80 }),
  finalSeed: fc.nat(),
});

export interface SimResult {
  replicas: Replica[];
  allOps: Op[];
  /** Failures found while running (intention and cursor-stability checks). */
  violations: string[];
}

/** Deterministic PRNG (mulberry32) so a failing scenario replays exactly. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** UTF-16 offsets that fall between code points, including 0 and the end. */
export function codePointBoundaries(s: string): number[] {
  const out = [0];
  let offset = 0;
  for (const cp of s) {
    offset += cp.length;
    out.push(offset);
  }
  return out;
}

export function applyChanges(text: string, changes: readonly Change[]): string {
  let out = text;
  for (const c of changes) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/** Where a tracked cursor (after a still-visible character) goes after `c`. */
function shiftCursor(cursor: number, c: Change): number {
  if (c.from >= cursor) return cursor;
  return cursor + c.insert.length - (c.to - c.from);
}

export function runScenario(sc: Scenario): SimResult {
  const n = sc.replicaCount;
  const replicas = Array.from({ length: n }, (_, i) => new Replica(`r${i}`));
  // queues[from][to]: ops sent by `from` not yet (fully) delivered to `to`
  const queues: Op[][][] = Array.from({ length: n }, () => Array.from({ length: n }, () => []));
  const allOps: Op[] = [];
  const violations: string[] = [];

  // A cursor tracked on replica 0, stored as a character id (design D6).
  let cursorId: CharId | null = null;

  const track = (): void => {
    const r0 = replicas[0]!;
    const bounds = codePointBoundaries(r0.getText());
    const idx = bounds[bounds.length - 1]! === 0 ? 0 : bounds[Math.floor(bounds.length / 2)]!;
    cursorId = r0.idAtIndex(idx);
  };

  const deliverTo = (to: number, ops: Op[]): void => {
    const target = replicas[to]!;
    // Cursor stability is checked only for single ops arriving at replica 0
    // while the cursor's character is visible.
    const check = to === 0 && cursorId !== null && ops.length === 1;
    const before = check ? target.indexOfId(cursorId!) : -1;
    const wasVisible = check ? isVisible(target, cursorId!) : false;
    const text = target.getText();
    const changes = target.applyRemote(ops);
    if (applyChanges(text, changes) !== target.getText()) {
      violations.push(`changes from applyRemote do not reproduce the text on r${to}`);
    }
    if (check && wasVisible && isVisible(target, cursorId!) && before >= 0) {
      let expected = before;
      for (const c of changes) expected = shiftCursor(expected, c);
      const actual = target.indexOfId(cursorId!);
      if (actual !== expected) {
        violations.push(`cursor moved from ${before} to ${actual}, expected ${expected}`);
      }
    }
  };

  for (const step of sc.steps) {
    if (step.t === "edit") {
      const rIdx = step.r % n;
      const r = replicas[rIdx]!;
      const bounds = codePointBoundaries(r.getText());
      const from = bounds[step.at % bounds.length]!;
      let ops: Op[];
      if (step.kind === "ins") {
        const before = r.getText();
        ops = r.localInsert(from, step.text);
        const inserted = step.text.replace(/\r\n?/g, "\n");
        const expected = before.slice(0, from) + inserted + before.slice(from);
        if (r.getText() !== expected) violations.push(`local insert intention broken on r${rIdx}`);
      } else {
        const start = bounds.indexOf(from);
        const to = bounds[Math.min(start + step.len, bounds.length - 1)]!;
        ops = r.localDelete(from, to - from);
      }
      allOps.push(...ops);
      for (let j = 0; j < n; j++) if (j !== rIdx) queues[rIdx]![j]!.push(...ops);
      if (rIdx === 0) track();
    } else {
      const from = step.from % n;
      const to = step.to % n;
      if (from === to) continue;
      const q = queues[from]![to]!;
      if (q.length === 0) continue;
      const k = step.pick % q.length;
      const op = q[k]!;
      if (!step.keep) q.splice(k, 1); // keep=true leaves a copy: a duplicate later
      deliverTo(to, [op]);
    }
  }

  // Final phase: deliver everything still queued, per replica, in a seeded
  // random order, with a random sprinkling of duplicates.
  const rand = prng(sc.finalSeed);
  for (let to = 0; to < n; to++) {
    const rest: Op[] = [];
    for (let from = 0; from < n; from++) if (from !== to) rest.push(...queues[from]![to]!);
    const withDupes = rest.flatMap((op) => (rand() < 0.2 ? [op, op] : [op]));
    deliverTo(to, shuffle(withDupes, rand));
  }
  return { replicas, allOps, violations };
}

function isVisible(r: Replica, id: CharId): boolean {
  if (id.clock === 0) return true;
  const key = idKey(id);
  return r.debugNodes().some((n) => idKey(n.id) === key && !n.deleted);
}

/** The text every replica should end up with, computed without any ordering logic. */
export function survivingChars(allOps: readonly Op[]): string[] {
  const deleted = new Set<string>();
  for (const op of allOps) if (op.type === "del") deleted.add(idKey(op.target));
  const out: string[] = [];
  for (const op of allOps) {
    if (op.type === "ins" && !deleted.has(idKey(op.id))) out.push(op.char);
  }
  return out;
}
