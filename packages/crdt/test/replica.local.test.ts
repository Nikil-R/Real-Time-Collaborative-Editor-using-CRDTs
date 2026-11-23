import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ROOT, Replica, compareIds, idKey } from "../src/index";

describe("compareIds", () => {
  it("orders by clock first", () => {
    expect(compareIds({ clock: 2, replica: "a" }, { clock: 1, replica: "z" })).toBeGreaterThan(0);
    expect(compareIds({ clock: 1, replica: "z" }, { clock: 2, replica: "a" })).toBeLessThan(0);
  });
  it("breaks clock ties by replica string", () => {
    expect(compareIds({ clock: 4, replica: "r" }, { clock: 4, replica: "p" })).toBeGreaterThan(0);
    expect(compareIds({ clock: 4, replica: "p" }, { clock: 4, replica: "r" })).toBeLessThan(0);
    expect(compareIds({ clock: 4, replica: "p" }, { clock: 4, replica: "p" })).toBe(0);
  });
  it("ROOT is smaller than every real id", () => {
    expect(compareIds(ROOT, { clock: 1, replica: "a" })).toBeLessThan(0);
  });
});

describe("Replica: local edits", () => {
  it("starts empty", () => {
    const r = new Replica("a");
    expect(r.getText()).toBe("");
    expect(r.nodeCount).toBe(0);
  });

  it("rejects an empty replica id", () => {
    expect(() => new Replica("")).toThrow(RangeError);
  });

  it("types characters one after another", () => {
    const r = new Replica("a");
    r.localInsert(0, "c");
    r.localInsert(1, "a");
    r.localInsert(2, "t");
    expect(r.getText()).toBe("cat");
  });

  it("inserts a multi-character string", () => {
    const r = new Replica("a");
    const ops = r.localInsert(0, "hello");
    expect(r.getText()).toBe("hello");
    expect(ops).toHaveLength(5);
  });

  it("chains origins inside one paste", () => {
    const r = new Replica("a");
    const ops = r.localInsert(0, "abc");
    expect(idKey(ops[0]!.origin)).toBe(idKey(ROOT));
    expect(ops[1]!.origin).toEqual(ops[0]!.id);
    expect(ops[2]!.origin).toEqual(ops[1]!.id);
  });

  it("gives every new character a larger clock", () => {
    const r = new Replica("a");
    const ops = r.localInsert(0, "xyz");
    expect(ops.map((o) => o.id.clock)).toEqual([1, 2, 3]);
    expect(ops.every((o) => o.id.replica === "a")).toBe(true);
  });

  it("inserts in the middle", () => {
    const r = new Replica("a");
    r.localInsert(0, "ac");
    r.localInsert(1, "b");
    expect(r.getText()).toBe("abc");
  });

  it("inserts at the start of existing text", () => {
    const r = new Replica("a");
    r.localInsert(0, "bc");
    r.localInsert(0, "a");
    expect(r.getText()).toBe("abc");
  });

  it("inserting an empty string does nothing", () => {
    const r = new Replica("a");
    r.localInsert(0, "ab");
    expect(r.localInsert(1, "")).toEqual([]);
    expect(r.getText()).toBe("ab");
  });

  it("deletes a range and keeps tombstones", () => {
    const r = new Replica("a");
    r.localInsert(0, "hello");
    const ops = r.localDelete(1, 3);
    expect(r.getText()).toBe("ho");
    expect(ops).toHaveLength(3);
    expect(r.nodeCount).toBe(5);
  });

  it("delete ops refer to character ids and carry unique op ids", () => {
    const r = new Replica("a");
    const ins = r.localInsert(0, "abc");
    const del = r.localDelete(0, 2);
    expect(del.map((o) => o.target)).toEqual([ins[0]!.id, ins[1]!.id]);
    expect(del.map((o) => o.opId.counter)).toEqual([1, 2]);
  });

  it("delete of length 0 is a no-op", () => {
    const r = new Replica("a");
    r.localInsert(0, "ab");
    expect(r.localDelete(1, 0)).toEqual([]);
    expect(r.getText()).toBe("ab");
  });

  it("deleting everything leaves an empty document that can be typed in again", () => {
    const r = new Replica("a");
    r.localInsert(0, "abc");
    r.localDelete(0, 3);
    expect(r.getText()).toBe("");
    r.localInsert(0, "xy");
    expect(r.getText()).toBe("xy");
  });

  it("indexes count visible text, skipping tombstones", () => {
    const r = new Replica("a");
    r.localInsert(0, "abcd");
    r.localDelete(1, 2); // text "ad", tombstones b and c sit between
    r.localInsert(1, "X");
    expect(r.getText()).toBe("aXd");
    r.localInsert(3, "!");
    expect(r.getText()).toBe("aXd!");
  });

  it("normalises line endings to \\n", () => {
    const r = new Replica("a");
    r.localInsert(0, "a\r\nb\rc");
    expect(r.getText()).toBe("a\nb\nc");
  });

  it("treats an emoji as one node of length 2", () => {
    const r = new Replica("a");
    const ops = r.localInsert(0, "a😀b");
    expect(ops).toHaveLength(3);
    expect(ops[1]!.char).toBe("😀");
    expect(r.getText()).toBe("a😀b");
    r.localInsert(3, "!"); // after the emoji (a=1, emoji=2)
    expect(r.getText()).toBe("a😀!b");
  });

  it("refuses to split a surrogate pair", () => {
    const r = new Replica("a");
    r.localInsert(0, "a😀b");
    expect(() => r.localInsert(2, "x")).toThrow(RangeError);
    expect(() => r.localDelete(2, 1)).toThrow(RangeError);
    expect(() => r.localDelete(1, 1)).toThrow(RangeError);
    expect(r.getText()).toBe("a😀b");
  });

  it("deletes a whole emoji", () => {
    const r = new Replica("a");
    r.localInsert(0, "a😀b");
    r.localDelete(1, 2);
    expect(r.getText()).toBe("ab");
  });

  it("rejects out-of-range and invalid indexes", () => {
    const r = new Replica("a");
    r.localInsert(0, "abc");
    expect(() => r.localInsert(4, "x")).toThrow(RangeError);
    expect(() => r.localInsert(-1, "x")).toThrow(RangeError);
    expect(() => r.localInsert(1.5, "x")).toThrow(RangeError);
    expect(() => r.localDelete(2, 5)).toThrow(RangeError);
    expect(() => r.localDelete(4, 1)).toThrow(RangeError);
    expect(r.getText()).toBe("abc");
  });
});

/**
 * Property test (docs/PROJECT-RULES.md rule 4). On Day 1 there is a single replica, so
 * "convergence" reduces to: any sequence of valid local edits must give exactly
 * the same text as the same edits applied to a plain JavaScript string.
 * The multi-replica convergence property (random order, duplicates, delays)
 * arrives with the simulator on Day 4.
 */
describe("Replica: property tests", () => {
  type Step =
    | { kind: "ins"; at: number; text: string }
    | { kind: "del"; at: number; len: number };

  const stepArb = fc.oneof(
    fc.record({
      kind: fc.constant("ins" as const),
      at: fc.nat(1000),
      text: fc.string({ unit: "grapheme", maxLength: 6 }),
    }),
    fc.record({
      kind: fc.constant("del" as const),
      at: fc.nat(1000),
      len: fc.nat(8),
    }),
  );

  it("matches a plain string model for random local edits", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps: Step[]) => {
        const replica = new Replica("a");
        let model = "";
        for (const step of steps) {
          // Snap to valid, code-point-aligned positions of the model string.
          const bounds = codePointBoundaries(model);
          if (step.kind === "ins") {
            const at = bounds[step.at % bounds.length]!;
            const text = step.text.replace(/\r\n?/g, "\n");
            replica.localInsert(at, step.text);
            model = model.slice(0, at) + text + model.slice(at);
          } else {
            const from = bounds[step.at % bounds.length]!;
            const toIdx = Math.min(bounds.indexOf(from) + step.len, bounds.length - 1);
            const to = bounds[toIdx]!;
            replica.localDelete(from, to - from);
            model = model.slice(0, from) + model.slice(to);
          }
          if (replica.getText() !== model) return false;
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

/** UTF-16 offsets that fall between code points, including 0 and the end. */
function codePointBoundaries(s: string): number[] {
  const out = [0];
  let offset = 0;
  for (const cp of s) {
    offset += cp.length;
    out.push(offset);
  }
  return out;
}
