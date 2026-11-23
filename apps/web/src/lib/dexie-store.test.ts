import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Replica, toWire } from "@rce/crdt";
import { DexieStore } from "./dexie-store";

function wireOps(replicaId: string, text: string, startN = 1) {
  const r = new Replica(replicaId);
  return r.localInsert(0, text).map((op, i) => toWire(op, { r: replicaId, n: startN + i }));
}

describe("DexieStore (IndexedDB outbox)", () => {
  it("returns an empty session for a replica it has never seen", async () => {
    const s = new DexieStore("doc-1", "r-fresh");
    expect(await s.load()).toEqual({ state: null, lastSeq: 0, outbox: [], nextOpN: 1 });
  });

  it("keeps unsent operations and the counter across a reload", async () => {
    const ops = wireOps("r-a", "abc");
    await new DexieStore("doc-1", "r-a").addToOutbox(ops, 4);
    const reloaded = await new DexieStore("doc-1", "r-a").load();
    expect(reloaded.outbox).toEqual(ops);
    expect(reloaded.nextOpN).toBe(4);
  });

  it("removes acknowledged operations only", async () => {
    const store = new DexieStore("doc-1", "r-b");
    const ops = wireOps("r-b", "xyz");
    await store.addToOutbox(ops, 4);
    await store.removeFromOutbox([1, 2]);
    const left = (await store.load()).outbox;
    expect(left.map((o) => o.op_id.n)).toEqual([3]);
  });

  it("does not mix the outboxes of two replicas", async () => {
    await new DexieStore("doc-2", "r-c").addToOutbox(wireOps("r-c", "11"), 3);
    await new DexieStore("doc-2", "r-d").addToOutbox(wireOps("r-d", "2"), 2);
    expect((await new DexieStore("doc-2", "r-c").load()).outbox).toHaveLength(2);
    expect((await new DexieStore("doc-2", "r-d").load()).outbox).toHaveLength(1);
  });

  it("saves and restores the cached CRDT state without losing the counter", async () => {
    const store = new DexieStore("doc-3", "r-e");
    await store.addToOutbox(wireOps("r-e", "hi"), 3);
    const replica = new Replica("r-e");
    replica.localInsert(0, "hi");
    await store.saveState(replica.getState(), 7);
    const loaded = await store.load();
    expect(loaded.lastSeq).toBe(7);
    expect(loaded.nextOpN).toBe(3);
    expect(Replica.fromState(loaded.state!, "r-e").getText()).toBe("hi");
  });
});
