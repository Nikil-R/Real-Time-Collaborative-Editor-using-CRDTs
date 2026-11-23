import {
  ROOT,
  compareIds,
  idEquals,
  idKey,
  opIdKey,
  type Change,
  type CharId,
  type DeleteOp,
  type InsertOp,
  type Node,
  type Op,
} from "./types";

/** Serialised replica state (design: getState / fromState). JSON-safe. */
export interface SerializedState {
  readonly v: 1;
  readonly replicaId: string;
  readonly clock: number;
  readonly opCounter: number;
  /** [clock, replica, char, deleted(0|1)] per node, in sequence order. */
  readonly nodes: ReadonlyArray<readonly [number, string, string, 0 | 1]>;
  /** Operations still waiting for their origin or target. */
  readonly pending: ReadonlyArray<Op>;
}

/**
 * One copy of the document (design section 4).
 *
 * All indexes passed in or returned are visible-text positions in UTF-16 code
 * units, the same unit JavaScript strings and CodeMirror use. An index that
 * would fall in the middle of a surrogate pair throws a RangeError.
 */
export class Replica {
  readonly replicaId: string;
  /** Lamport clock. Only ever goes up. */
  private clock = 0;
  /** Counter for delete-operation ids. */
  private opCounter = 0;
  /** The sequence, tombstones included. ROOT is implicit at index -1. */
  private nodes: Node[] = [];
  /** idKey -> position in `nodes`. Kept in step with the array. */
  private index = new Map<string, number>();
  /** Ids of every applied insert (idempotence). */
  private seen = new Set<string>();
  /** Inserts waiting for their origin, keyed by the origin's idKey. */
  private pendingInserts = new Map<string, InsertOp[]>();
  private pendingInsertKeys = new Set<string>();
  /** Deletes waiting for their target, keyed by the target's idKey. */
  private pendingDeletes = new Map<string, DeleteOp[]>();
  private pendingDeleteKeys = new Set<string>();

  constructor(replicaId: string) {
    if (replicaId === "") {
      // "" is the replica of ROOT; a real replica using it would collide.
      throw new RangeError("replicaId must be a non-empty string");
    }
    this.replicaId = replicaId;
  }

  // ---------------------------------------------------------------- reading

  /** Visible text: every node that is not a tombstone. */
  getText(): string {
    let out = "";
    for (const node of this.nodes) {
      if (!node.deleted) out += node.char;
    }
    return out;
  }

  /** Length of the visible text in UTF-16 code units. */
  get length(): number {
    let n = 0;
    for (const node of this.nodes) {
      if (!node.deleted) n += node.char.length;
    }
    return n;
  }

  /** Number of nodes including tombstones. */
  get nodeCount(): number {
    return this.nodes.length;
  }

  /** Number of operations parked while waiting for a dependency. */
  get pendingCount(): number {
    return this.pendingInsertKeys.size + this.pendingDeleteKeys.size;
  }

  /** Current Lamport clock (for tests and the debug panel). */
  get currentClock(): number {
    return this.clock;
  }

  /** Copy of the sequence for the debug panel and tests. */
  debugNodes(): Array<{ id: CharId; char: string; deleted: boolean }> {
    return this.nodes.map((n) => ({ id: n.id, char: n.char, deleted: n.deleted }));
  }

  // ------------------------------------------------------------ local edits

  /**
   * Type `text` at visible index `index`. Returns the operations to send.
   * Each character becomes one InsertOp whose origin is the previous one
   * (design section 6), so a paste is a chain.
   */
  localInsert(index: number, text: string): InsertOp[] {
    const chars = Array.from(normalizeNewlines(text)); // one entry per code point
    let origin = this.idAtIndex(index);
    const ops: InsertOp[] = [];
    for (const char of chars) {
      this.clock += 1;
      const op: InsertOp = {
        type: "ins",
        id: { clock: this.clock, replica: this.replicaId },
        origin,
        char,
      };
      this.insertNode(op);
      ops.push(op);
      origin = op.id;
    }
    return ops;
  }

  /**
   * Delete the visible range [index, index + length). Returns one DeleteOp
   * per character. Tombstones the nodes; nothing is removed from the array.
   */
  localDelete(index: number, length: number): DeleteOp[] {
    assertNonNegativeInteger(index, "index");
    assertNonNegativeInteger(length, "length");
    if (length === 0) return [];

    const end = index + length;
    const targets: Node[] = [];
    let offset = 0;
    let startAligned = index === 0;
    let endAligned = false;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (offset === index) startAligned = true;
      if (offset >= index && offset < end) targets.push(node);
      offset += node.char.length;
      if (offset === end) endAligned = true;
      if (offset >= end) break;
    }
    if (!startAligned || !endAligned) {
      throw new RangeError(
        `delete range [${index}, ${end}) is outside the text or splits a surrogate pair`,
      );
    }

    const ops: DeleteOp[] = [];
    for (const node of targets) {
      node.deleted = true;
      this.opCounter += 1;
      ops.push({
        type: "del",
        target: node.id,
        opId: { replica: this.replicaId, counter: this.opCounter },
      });
    }
    return ops;
  }

  // ----------------------------------------------------------- remote edits

  /**
   * Apply operations received from elsewhere, in any order, with duplicates.
   * Operations whose dependency (origin or target) is missing are parked and
   * applied automatically once it arrives (design section 11).
   *
   * Returns the visible-text changes, in application order, for the editor.
   */
  applyRemote(ops: readonly Op[]): Change[] {
    const changes: Change[] = [];
    const queue: Op[] = [...ops];
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i]!;
      if (op.type === "ins") {
        this.applyRemoteInsert(op, queue, changes);
      } else {
        this.applyRemoteDelete(op, changes);
      }
    }
    return changes;
  }

  private applyRemoteInsert(op: InsertOp, queue: Op[], changes: Change[]): void {
    const key = idKey(op.id);
    if (this.seen.has(key)) return; // duplicate: idempotent
    if (!idEquals(op.origin, ROOT) && !this.index.has(idKey(op.origin))) {
      this.parkInsert(op);
      return;
    }
    // If this op was parked earlier it is being released now (it was already
    // removed from the by-origin map when its origin was integrated).
    this.pendingInsertKeys.delete(key);
    const pos = this.insertNode(op);
    const at = this.visibleOffsetBefore(pos);
    pushChange(changes, { from: at, to: at, insert: op.char });
    // Anything that was waiting for this character can go now.
    const waitingInserts = this.pendingInserts.get(key);
    if (waitingInserts) {
      this.pendingInserts.delete(key);
      queue.push(...waitingInserts);
    }
    const waitingDeletes = this.pendingDeletes.get(key);
    if (waitingDeletes) {
      this.pendingDeletes.delete(key);
      for (const d of waitingDeletes) this.pendingDeleteKeys.delete(opIdKey(d.opId));
      queue.push(...waitingDeletes);
    }
  }

  private applyRemoteDelete(op: DeleteOp, changes: Change[]): void {
    const targetKey = idKey(op.target);
    const pos = this.index.get(targetKey);
    if (pos === undefined) {
      this.parkDelete(op);
      return;
    }
    const node = this.nodes[pos]!;
    if (node.deleted) return; // duplicate or already deleted: nothing to do
    const from = this.visibleOffsetBefore(pos);
    node.deleted = true;
    pushChange(changes, { from, to: from + node.char.length, insert: "" });
  }

  private parkInsert(op: InsertOp): void {
    const key = idKey(op.id);
    if (this.pendingInsertKeys.has(key)) return;
    this.pendingInsertKeys.add(key);
    const originKey = idKey(op.origin);
    const list = this.pendingInserts.get(originKey);
    if (list) list.push(op);
    else this.pendingInserts.set(originKey, [op]);
  }

  private parkDelete(op: DeleteOp): void {
    const key = opIdKey(op.opId);
    if (this.pendingDeleteKeys.has(key)) return;
    this.pendingDeleteKeys.add(key);
    const targetKey = idKey(op.target);
    const list = this.pendingDeletes.get(targetKey);
    if (list) list.push(op);
    else this.pendingDeletes.set(targetKey, [op]);
  }

  // ----------------------------------------------------------------- cursors

  /**
   * Cursor helper. For a cursor sitting at visible `index`, returns the id of
   * the character immediately to its left (ROOT at index 0). Storing this id
   * instead of the number keeps the cursor attached when others edit.
   */
  idAtIndex(index: number): CharId {
    assertNonNegativeInteger(index, "index");
    if (index === 0) return ROOT;
    let offset = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      offset += node.char.length;
      if (offset === index) return node.id;
      if (offset > index) {
        throw new RangeError(`index ${index} splits a surrogate pair`);
      }
    }
    throw new RangeError(`index ${index} is beyond the end of the text (${offset})`);
  }

  /**
   * Inverse of `idAtIndex`: the visible index of a cursor placed right after
   * the character `id`. If that character was deleted, the cursor sits where
   * it used to be. ROOT gives 0. Returns -1 for an id this replica has not seen.
   */
  indexOfId(id: CharId): number {
    if (idEquals(id, ROOT)) return 0;
    const pos = this.index.get(idKey(id));
    if (pos === undefined) return -1;
    return this.visibleOffsetBefore(pos + 1);
  }

  // ------------------------------------------------------------------ state

  getState(): SerializedState {
    const pending: Op[] = [];
    for (const list of this.pendingInserts.values()) pending.push(...list);
    for (const list of this.pendingDeletes.values()) pending.push(...list);
    return {
      v: 1,
      replicaId: this.replicaId,
      clock: this.clock,
      opCounter: this.opCounter,
      nodes: this.nodes.map((n) => [n.id.clock, n.id.replica, n.char, n.deleted ? 1 : 0] as const),
      pending,
    };
  }

  /**
   * Rebuild a replica from `getState()` output. If `replicaId` equals the one
   * stored in the state, its delete counter continues where it stopped;
   * otherwise a fresh replica starts from the same document.
   */
  static fromState(state: SerializedState, replicaId: string): Replica {
    if (state.v !== 1) throw new Error(`unsupported state version ${String(state.v)}`);
    const r = new Replica(replicaId);
    r.clock = state.clock;
    if (replicaId === state.replicaId) r.opCounter = state.opCounter;
    for (const [clock, replica, char, deleted] of state.nodes) {
      const id: CharId = { clock, replica };
      const key = idKey(id);
      r.index.set(key, r.nodes.length);
      r.seen.add(key);
      r.nodes.push({ id, char, deleted: deleted === 1 });
    }
    for (const op of state.pending) {
      if (op.type === "ins") r.parkInsert(op);
      else r.parkDelete(op);
    }
    return r;
  }

  // -------------------------------------------------------------- internals

  /**
   * The RGA ordering rule (design section 7): start right after the origin and
   * move right past every node with a larger id, then insert. The caller has
   * checked that the origin exists and that `op` is not a duplicate.
   * Returns the position the node was inserted at.
   */
  private insertNode(op: InsertOp): number {
    let pos: number;
    if (idEquals(op.origin, ROOT)) {
      pos = 0;
    } else {
      const originPos = this.index.get(idKey(op.origin));
      if (originPos === undefined) {
        throw new Error(`origin ${idKey(op.origin)} not found`);
      }
      pos = originPos + 1;
    }

    while (pos < this.nodes.length && compareIds(this.nodes[pos]!.id, op.id) > 0) {
      pos += 1;
    }

    this.nodes.splice(pos, 0, { id: op.id, char: op.char, deleted: false });
    // Everything from `pos` onwards shifted by one: refresh their positions.
    for (let i = pos; i < this.nodes.length; i++) {
      this.index.set(idKey(this.nodes[i]!.id), i);
    }
    this.seen.add(idKey(op.id));
    if (op.id.clock > this.clock) this.clock = op.id.clock;
    return pos;
  }

  /** UTF-16 length of the visible text before node position `pos`. */
  private visibleOffsetBefore(pos: number): number {
    let offset = 0;
    for (let i = 0; i < pos; i++) {
      const n = this.nodes[i]!;
      if (!n.deleted) offset += n.char.length;
    }
    return offset;
  }
}

/** Design section 10: normalise line endings to "\n". */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

/** Append a change, merging it into the previous one when they are adjacent. */
function pushChange(changes: Change[], next: Change): void {
  const prev = changes[changes.length - 1];
  if (prev && prev.insert !== "" && prev.from === prev.to && next.insert !== "" && next.from === next.to) {
    // Both pure inserts; merge when `next` lands right after `prev`'s text.
    if (next.from === prev.from + prev.insert.length) {
      changes[changes.length - 1] = { from: prev.from, to: prev.to, insert: prev.insert + next.insert };
      return;
    }
  }
  changes.push(next);
}
