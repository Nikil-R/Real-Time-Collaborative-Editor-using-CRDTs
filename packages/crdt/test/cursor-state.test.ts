import { describe, expect, it } from "vitest";
import { ROOT, Replica, idEquals } from "../src/index";

describe("cursor helpers", () => {
  it("idAtIndex(0) is ROOT and indexOfId(ROOT) is 0", () => {
    const r = new Replica("a");
    r.localInsert(0, "abc");
    expect(idEquals(r.idAtIndex(0), ROOT)).toBe(true);
    expect(r.indexOfId(ROOT)).toBe(0);
  });

  it("idAtIndex and indexOfId are inverse on visible positions", () => {
    const r = new Replica("a");
    r.localInsert(0, "a😀bc");
    for (const i of [0, 1, 3, 4, 5]) {
      expect(r.indexOfId(r.idAtIndex(i))).toBe(i);
    }
  });

  it("rejects an index inside a surrogate pair or past the end", () => {
    const r = new Replica("a");
    r.localInsert(0, "a😀");
    expect(() => r.idAtIndex(2)).toThrow(RangeError);
    expect(() => r.idAtIndex(4)).toThrow(RangeError);
  });

  it("returns -1 for an id the replica has not seen", () => {
    const r = new Replica("a");
    expect(r.indexOfId({ clock: 9, replica: "zz" })).toBe(-1);
  });

  it("a cursor stays on its character when a remote user types before it", () => {
    const alice = new Replica("alice");
    const bob = new Replica("bob");
    bob.applyRemote(alice.localInsert(0, "hello world"));
    const cursor = bob.idAtIndex(5); // right after "hello"
    expect(bob.indexOfId(cursor)).toBe(5);
    bob.applyRemote(alice.localInsert(0, ">>> "));
    expect(bob.indexOfId(cursor)).toBe(9);
    expect(bob.getText().slice(0, 9)).toBe(">>> hello");
  });

  it("a cursor does not move when a remote user types after it", () => {
    const alice = new Replica("alice");
    const bob = new Replica("bob");
    bob.applyRemote(alice.localInsert(0, "hello world"));
    const cursor = bob.idAtIndex(5);
    bob.applyRemote(alice.localInsert(11, "!!!"));
    expect(bob.indexOfId(cursor)).toBe(5);
  });

  it("a cursor shifts left when remote text before it is deleted", () => {
    const alice = new Replica("alice");
    const bob = new Replica("bob");
    bob.applyRemote(alice.localInsert(0, "abcdef"));
    const cursor = bob.idAtIndex(4);
    bob.applyRemote(alice.localDelete(0, 2));
    expect(bob.indexOfId(cursor)).toBe(2);
  });

  it("a cursor on a deleted character stays at the place it was", () => {
    const alice = new Replica("alice");
    const bob = new Replica("bob");
    bob.applyRemote(alice.localInsert(0, "abcdef"));
    const cursor = bob.idAtIndex(3); // after "c"
    bob.applyRemote(alice.localDelete(2, 1)); // delete "c"
    expect(bob.getText()).toBe("abdef");
    expect(bob.indexOfId(cursor)).toBe(2);
  });
});

describe("state serialisation", () => {
  it("round-trips through JSON and keeps working", () => {
    const a = new Replica("a");
    a.localInsert(0, "hello 😀");
    a.localDelete(1, 2);
    const state = JSON.parse(JSON.stringify(a.getState())) as ReturnType<Replica["getState"]>;
    const copy = Replica.fromState(state, "a");
    expect(copy.getText()).toBe(a.getText());
    expect(copy.nodeCount).toBe(a.nodeCount);

    // Same replica id: clocks and delete counters continue without reuse.
    const next = copy.localInsert(copy.length, "!");
    expect(next[0]!.id.clock).toBeGreaterThan(a.currentClock);
    const del = copy.localDelete(0, 1);
    expect(del[0]!.opId.counter).toBe(3);
  });

  it("a different replica id starts a fresh delete counter but keeps the clock", () => {
    const a = new Replica("a");
    a.localInsert(0, "abc");
    a.localDelete(0, 1);
    const b = Replica.fromState(a.getState(), "b");
    expect(b.getText()).toBe("bc");
    const [op] = b.localInsert(2, "!");
    expect(op!.id.replica).toBe("b");
    expect(op!.id.clock).toBe(4);
    expect(b.localDelete(0, 1)[0]!.opId).toEqual({ replica: "b", counter: 1 });
  });

  it("keeps pending operations across a round trip", () => {
    const a = new Replica("a");
    const [first, second] = a.localInsert(0, "xy");
    const b = new Replica("b");
    b.applyRemote([second!]);
    expect(b.pendingCount).toBe(1);
    const c = Replica.fromState(JSON.parse(JSON.stringify(b.getState())), "b");
    expect(c.pendingCount).toBe(1);
    c.applyRemote([first!]);
    expect(c.getText()).toBe("xy");
    expect(c.pendingCount).toBe(0);
  });

  it("rejects an unknown state version", () => {
    const a = new Replica("a");
    const bad = { ...a.getState(), v: 2 } as unknown as ReturnType<Replica["getState"]>;
    expect(() => Replica.fromState(bad, "a")).toThrow();
  });
});
