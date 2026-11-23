/**
 * Property-based convergence tests (docs/PROJECT-RULES.md rule 4, docs/07-TESTING.md 3).
 *
 * Number of random schedules per property: env FC_RUNS (default 2000 so the
 * normal test run stays fast). `pnpm test:crdt:full` runs 10,000.
 * fast-check prints the seed and the shrunk counterexample on failure; copy it
 * into test/regressions.test.ts.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Replica, type Op } from "../src/index";
import {
  applyChanges,
  codePointBoundaries,
  prng,
  runScenario,
  scenarioArb,
  shuffle,
  survivingChars,
} from "./simulator";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const NUM_RUNS = Number(env?.FC_RUNS ?? 2000);

function sortedChars(s: string): string[] {
  return Array.from(s).sort();
}

describe("CRDT convergence (property based)", () => {
  it("1. convergence: all replicas show identical text after all ops are delivered", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const { replicas } = runScenario(sc);
        const texts = replicas.map((r) => r.getText());
        expect(new Set(texts).size).toBe(1);
        // Internal structure must agree too, not only the visible text.
        const nodes = replicas.map((r) => JSON.stringify(r.debugNodes()));
        expect(new Set(nodes).size).toBe(1);
        expect(replicas.every((r) => r.pendingCount === 0)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("2. order independence: the same ops in two other random orders give the same text", () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(), fc.nat(), (sc, s1, s2) => {
        const { replicas, allOps } = runScenario(sc);
        const expected = replicas[0]!.getText();
        for (const seed of [s1, s2]) {
          const fresh = new Replica("fresh");
          fresh.applyRemote(shuffle(allOps, prng(seed)));
          expect(fresh.getText()).toBe(expected);
          expect(fresh.pendingCount).toBe(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("3. idempotence: re-applying every op changes nothing", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const { replicas, allOps } = runScenario(sc);
        for (const r of replicas) {
          const before = r.getText();
          const nodes = r.nodeCount;
          const changes = r.applyRemote(allOps);
          expect(changes).toEqual([]);
          expect(r.getText()).toBe(before);
          expect(r.nodeCount).toBe(nodes);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("4+5+6. intention, deletions respected, no lost or duplicated characters", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const { replicas, violations, allOps } = runScenario(sc);
        // 4. intention (checked inside the simulator on every local insert)
        // and change reporting / cursor stability (property 8 below):
        expect(violations).toEqual([]);
        // 5 + 6. the final text is exactly the surviving characters, each once.
        const expected = survivingChars(allOps).sort();
        for (const r of replicas) {
          expect(sortedChars(r.getText())).toEqual(expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("7. serialisation round trip: fromState(getState()) matches and behaves identically", () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(), (sc, seed) => {
        const { replicas, allOps } = runScenario(sc);
        const original = replicas[0]!;
        const state = JSON.parse(JSON.stringify(original.getState())) as ReturnType<Replica["getState"]>;
        const copy = Replica.fromState(state, original.replicaId);
        expect(copy.getText()).toBe(original.getText());
        expect(JSON.stringify(copy.debugNodes())).toBe(JSON.stringify(original.debugNodes()));

        // Later ops behave the same on both.
        const author = replicas[1]!;
        const bounds = codePointBoundaries(author.getText());
        const at = bounds[seed % bounds.length]!;
        const more: Op[] = author.localInsert(at, "Z!");
        original.applyRemote(more);
        copy.applyRemote(more);
        expect(copy.getText()).toBe(original.getText());

        // A snapshot taken from a replica can bootstrap a new one that then
        // keeps converging with everybody else.
        const joiner = Replica.fromState(state, "joiner");
        joiner.applyRemote(allOps); // idempotent
        joiner.applyRemote(more);
        expect(joiner.getText()).toBe(original.getText());
      }),
      { numRuns: Math.min(NUM_RUNS, 1000) },
    );
  });

  it("changes returned by applyRemote always reproduce the visible text", () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(), (sc, seed) => {
        const { allOps } = runScenario(sc);
        const fresh = new Replica("fresh");
        let text = "";
        for (const op of shuffle(allOps, prng(seed))) {
          text = applyChanges(text, fresh.applyRemote([op]));
          expect(text).toBe(fresh.getText());
        }
      }),
      { numRuns: Math.min(NUM_RUNS, 1000) },
    );
  });
});
