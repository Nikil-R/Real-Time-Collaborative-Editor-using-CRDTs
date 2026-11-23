import { describe, expect, it } from "vitest";
import { Replica, type Op } from "../src/index";

/** Make replicas `names` that all start from the document `text` typed by "a". */
function syncedReplicas(text: string, names: string[]): { replicas: Replica[]; setup: Op[] } {
  const author = new Replica("a");
  const setup = author.localInsert(0, text);
  const replicas = names.map((n) => {
    const r = new Replica(n);
    r.applyRemote(setup);
    return r;
  });
  return { replicas, setup };
}

describe("Replica: remote apply and the ordering rule", () => {
  it("applies a remote insert to an empty replica", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const changes = b.applyRemote(a.localInsert(0, "hi"));
    expect(b.getText()).toBe("hi");
    expect(changes).toEqual([{ from: 0, to: 0, insert: "hi" }]);
  });

  it("Priya/Rahul example: concurrent inserts at the same spot give CASRT on both", () => {
    const { replicas } = syncedReplicas("CAT", ["p", "r"]);
    const [priya, rahul] = replicas as [Replica, Replica];
    expect(priya.getText()).toBe("CAT");

    const opsP = priya.localInsert(2, "R"); // after A
    const opsR = rahul.localInsert(2, "S"); // after A, concurrently
    expect(opsP[0]!.id).toEqual({ clock: 4, replica: "p" });
    expect(opsR[0]!.id).toEqual({ clock: 4, replica: "r" });

    priya.applyRemote(opsR);
    rahul.applyRemote(opsP);
    expect(priya.getText()).toBe("CASRT");
    expect(rahul.getText()).toBe("CASRT");
  });

  it("two replicas exchanging ops in either order produce identical text", () => {
    for (const reverse of [false, true]) {
      const { replicas } = syncedReplicas("hello", ["x", "y"]);
      const [x, y] = replicas as [Replica, Replica];
      const opsX = x.localInsert(5, " world");
      const opsY = y.localInsert(5, " there");
      x.applyRemote(reverse ? [...opsY].reverse() : opsY);
      y.applyRemote(reverse ? [...opsX].reverse() : opsX);
      expect(x.getText()).toBe(y.getText());
    }
  });

  it("three replicas inserting after the same origin converge", () => {
    const { replicas } = syncedReplicas("AB", ["p", "q", "r"]);
    const [p, q, r] = replicas as [Replica, Replica, Replica];
    const op1 = p.localInsert(1, "1");
    const op2 = q.localInsert(1, "2");
    const op3 = r.localInsert(1, "3");
    // Each replica sees the others in a different order.
    p.applyRemote([...op3, ...op2]);
    q.applyRemote([...op1, ...op3]);
    r.applyRemote([...op2, ...op1]);
    expect(p.getText()).toBe(q.getText());
    expect(q.getText()).toBe(r.getText());
    expect(p.getText()).toHaveLength(5);
  });

  it("keeps a concurrent word typed after a character together with its subtree", () => {
    const { replicas } = syncedReplicas("X", ["p", "q"]);
    const [p, q] = replicas as [Replica, Replica];
    const opsP = p.localInsert(1, "abc");
    const opsQ = q.localInsert(1, "123");
    p.applyRemote(opsQ);
    q.applyRemote(opsP);
    expect(p.getText()).toBe(q.getText());
    // Runs typed in one go stay contiguous here (no interleaving for this case).
    expect(["Xabc123", "X123abc"]).toContain(p.getText());
  });

  it("moves the Lamport clock forward after seeing a larger remote clock", () => {
    const src = new Replica("src");
    const c = new Replica("c");
    c.applyRemote(src.localInsert(0, "xyz")); // remote clocks 1..3
    expect(c.currentClock).toBe(3);
    const mine = c.localInsert(3, "!");
    expect(mine[0]!.id.clock).toBe(4); // larger than everything c has seen
  });

  it("does not move the clock for an op that is still pending", () => {
    const src = new Replica("src");
    const [, second] = src.localInsert(0, "xy") as [Op, Op];
    const c = new Replica("c");
    c.applyRemote([second]);
    expect(c.currentClock).toBe(0);
  });

  it("applies a remote delete and reports the change", () => {
    const { replicas } = syncedReplicas("hello", ["p", "q"]);
    const [p, q] = replicas as [Replica, Replica];
    const del = p.localDelete(1, 3);
    const changes = q.applyRemote(del);
    expect(q.getText()).toBe("ho");
    expect(p.getText()).toBe("ho");
    expect(changes.reduce((n, c) => n + (c.to - c.from), 0)).toBe(3);
  });

  it("an insert after a deleted character (tombstone origin) still places correctly", () => {
    const { replicas } = syncedReplicas("abc", ["p", "q"]);
    const [p, q] = replicas as [Replica, Replica];
    const del = p.localDelete(1, 1); // delete b
    const ins = q.localInsert(2, "X"); // after b, concurrently
    p.applyRemote(ins);
    q.applyRemote(del);
    expect(p.getText()).toBe("aXc");
    expect(q.getText()).toBe("aXc");
  });

  it("reports remote change positions in current visible coordinates", () => {
    const { replicas } = syncedReplicas("abc", ["p", "q"]);
    const [p, q] = replicas as [Replica, Replica];
    const ops = p.localInsert(1, "ZZ");
    const changes = q.applyRemote(ops);
    expect(changes).toEqual([{ from: 1, to: 1, insert: "ZZ" }]);
    expect(q.getText()).toBe("aZZbc");
  });
});

describe("Replica: pending buffer and idempotence", () => {
  it("buffers an insert that arrives before its origin, then applies it", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const [first, second] = a.localInsert(0, "xy") as [Op, Op];
    b.applyRemote([second]);
    expect(b.getText()).toBe("");
    expect(b.pendingCount).toBe(1);
    b.applyRemote([first]);
    expect(b.getText()).toBe("xy");
    expect(b.pendingCount).toBe(0);
  });

  it("applies a whole paste delivered in reverse order", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const ops = a.localInsert(0, "reverse me");
    b.applyRemote([...ops].reverse());
    expect(b.getText()).toBe("reverse me");
    expect(b.pendingCount).toBe(0);
  });

  it("reports the released pending ops as changes in the right order", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const ops = a.localInsert(0, "abc");
    const changes = b.applyRemote([...ops].reverse());
    // Applying the changes in order to an empty string must give the text.
    expect(applyChanges("", changes)).toBe("abc");
  });

  it("ignores a duplicate insert", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const ops = a.localInsert(0, "hi");
    b.applyRemote(ops);
    const changes = b.applyRemote(ops);
    expect(changes).toEqual([]);
    expect(b.getText()).toBe("hi");
    expect(b.nodeCount).toBe(2);
  });

  it("ignores a duplicate delete", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    b.applyRemote(a.localInsert(0, "abc"));
    const del = a.localDelete(0, 1);
    b.applyRemote(del);
    expect(b.applyRemote(del)).toEqual([]);
    expect(b.getText()).toBe("bc");
  });

  it("buffers a delete that arrives before the insert it targets", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const ins = a.localInsert(0, "abc");
    const del = a.localDelete(1, 1);
    b.applyRemote(del);
    expect(b.pendingCount).toBe(1);
    b.applyRemote(ins);
    expect(b.getText()).toBe("ac");
    expect(b.pendingCount).toBe(0);
  });

  it("does not park the same pending op twice", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const [, second] = a.localInsert(0, "xy") as [Op, Op];
    b.applyRemote([second, second, second]);
    expect(b.pendingCount).toBe(1);
  });

  it("applying an op to the replica that created it changes nothing", () => {
    const a = new Replica("a");
    const ops = a.localInsert(0, "own");
    expect(a.applyRemote(ops)).toEqual([]);
    expect(a.getText()).toBe("own");
  });
});

function applyChanges(text: string, changes: readonly { from: number; to: number; insert: string }[]): string {
  let out = text;
  for (const c of changes) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}
