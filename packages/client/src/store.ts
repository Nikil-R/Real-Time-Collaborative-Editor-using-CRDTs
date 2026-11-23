import type { SerializedState, WireOp } from "@rce/crdt";

/** What survives a reload (docs/01-PRD.md U6). */
export interface StoredSession {
  /** Last saved CRDT state, if any (may lag behind the outbox). */
  state: SerializedState | null;
  /** The seq watermark that goes with `state`. */
  lastSeq: number;
  /** Operations created locally and not yet acknowledged by the server. */
  outbox: WireOp[];
  /** Next per-replica operation counter (op_id.n). */
  nextOpN: number;
}

/**
 * Persistence used by the session. The browser provides an IndexedDB version;
 * tests and the load test use `MemoryStore`.
 */
export interface LocalStore {
  load(): Promise<StoredSession>;
  /** Persist new outbox entries together with the counter, before sending. */
  addToOutbox(ops: WireOp[], nextOpN: number): Promise<void>;
  /** Forget acknowledged operations by their op_id.n. */
  removeFromOutbox(ns: number[]): Promise<void>;
  saveState(state: SerializedState, lastSeq: number): Promise<void>;
}

export class MemoryStore implements LocalStore {
  private data: StoredSession = { state: null, lastSeq: 0, outbox: [], nextOpN: 1 };

  load(): Promise<StoredSession> {
    return Promise.resolve(structuredClone(this.data));
  }

  addToOutbox(ops: WireOp[], nextOpN: number): Promise<void> {
    this.data.outbox.push(...structuredClone(ops));
    this.data.nextOpN = Math.max(this.data.nextOpN, nextOpN);
    return Promise.resolve();
  }

  removeFromOutbox(ns: number[]): Promise<void> {
    const gone = new Set(ns);
    this.data.outbox = this.data.outbox.filter((o) => !gone.has(o.op_id.n));
    return Promise.resolve();
  }

  saveState(state: SerializedState, lastSeq: number): Promise<void> {
    this.data.state = structuredClone(state);
    this.data.lastSeq = lastSeq;
    return Promise.resolve();
  }
}
