import Dexie, { type EntityTable } from "dexie";
import type { LocalStore, StoredSession } from "@rce/client";
import type { SerializedState, WireOp } from "@rce/crdt";

/**
 * IndexedDB persistence for one replica: the outbox of unacknowledged
 * operations (so offline typing survives a reload) and a cached copy of the
 * CRDT state (so the document opens instantly, even offline).
 */
interface OutboxRow {
  replica: string;
  n: number;
  op: WireOp;
}
interface MetaRow {
  replica: string;
  docId: string;
  nextOpN: number;
  lastSeq: number;
  state: SerializedState | null;
}

class RceDb extends Dexie {
  outbox!: EntityTable<OutboxRow, "n">;
  meta!: EntityTable<MetaRow, "replica">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      outbox: "[replica+n], replica",
      meta: "replica",
    });
  }
}

let shared: RceDb | null = null;
function db(): RceDb {
  shared ??= new RceDb("rce");
  return shared;
}

export class DexieStore implements LocalStore {
  constructor(
    private readonly docId: string,
    private readonly replica: string,
  ) {}

  async load(): Promise<StoredSession> {
    const d = db();
    const meta = await d.meta.get(this.replica);
    const rows = await d.outbox.where("replica").equals(this.replica).toArray();
    return {
      state: meta?.state ?? null,
      lastSeq: meta?.lastSeq ?? 0,
      outbox: rows.sort((a, b) => a.n - b.n).map((r) => r.op),
      nextOpN: meta?.nextOpN ?? 1,
    };
  }

  async addToOutbox(ops: WireOp[], nextOpN: number): Promise<void> {
    const d = db();
    await d.transaction("rw", d.outbox, d.meta, async () => {
      await d.outbox.bulkPut(ops.map((op) => ({ replica: this.replica, n: op.op_id.n, op })));
      const meta = await d.meta.get(this.replica);
      await d.meta.put({
        replica: this.replica,
        docId: this.docId,
        nextOpN: Math.max(meta?.nextOpN ?? 1, nextOpN),
        lastSeq: meta?.lastSeq ?? 0,
        state: meta?.state ?? null,
      });
    });
  }

  async removeFromOutbox(ns: number[]): Promise<void> {
    await db().outbox.bulkDelete(ns.map((n) => [this.replica, n]) as never);
  }

  async saveState(state: SerializedState, lastSeq: number): Promise<void> {
    const d = db();
    await d.transaction("rw", d.meta, async () => {
      const meta = await d.meta.get(this.replica);
      await d.meta.put({
        replica: this.replica,
        docId: this.docId,
        nextOpN: meta?.nextOpN ?? 1,
        lastSeq,
        state,
      });
    });
  }
}
