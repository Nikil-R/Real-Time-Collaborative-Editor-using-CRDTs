import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Replica, fromWire, toWire, type WireOp } from "../src/index";
import { scenarioArb, runScenario } from "./simulator";

describe("wire codec", () => {
  it("matches the shape in docs/04-PROTOCOL.md", () => {
    const a = new Replica("r-8f2c");
    const [ins] = a.localInsert(0, "R");
    const wire = toWire(ins!, { r: "r-8f2c", n: 41 });
    expect(wire).toEqual({
      op_id: { r: "r-8f2c", n: 41 },
      kind: "ins",
      id: { c: 1, r: "r-8f2c" },
      origin: { c: 0, r: "" },
      ch: "R",
    });
    const [del] = a.localDelete(0, 1);
    expect(toWire(del!, { r: "r-8f2c", n: 42 })).toEqual({
      op_id: { r: "r-8f2c", n: 42 },
      kind: "del",
      target: { c: 1, r: "r-8f2c" },
    });
  });

  it("round-trips every operation of random scenarios through JSON", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const { allOps, replicas } = runScenario(sc);
        const viaWire = allOps.map((op, i) => {
          const wire = toWire(op, { r: "x", n: i + 1 });
          return fromWire(JSON.parse(JSON.stringify(wire)) as WireOp);
        });
        const fresh = new Replica("fresh");
        fresh.applyRemote(viaWire);
        expect(fresh.getText()).toBe(replicas[0]!.getText());
      }),
      { numRuns: 300 },
    );
  });

  it("rejects malformed operations", () => {
    const bad: unknown[] = [
      null,
      "x",
      {},
      { op_id: { r: "a", n: 1 }, kind: "nope" },
      { op_id: { r: "a", n: 0 }, kind: "del", target: { c: 1, r: "a" } },
      { op_id: { r: "a", n: 1 }, kind: "ins", id: { c: 1, r: "a" }, origin: { c: 0, r: "" }, ch: "" },
      { op_id: { r: "a", n: 1 }, kind: "ins", id: { c: -1, r: "a" }, origin: { c: 0, r: "" }, ch: "x" },
      { op_id: { r: "a", n: 1 }, kind: "ins", id: { c: 1, r: "a" }, origin: { c: 0, r: "" }, ch: "toolong" },
      { op_id: { r: "a", n: 1 }, kind: "del", target: { c: 1.5, r: "a" } },
    ];
    for (const b of bad) expect(() => fromWire(b)).toThrow(TypeError);
  });
});
