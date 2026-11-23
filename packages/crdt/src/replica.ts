import {
  ROOT,
  compareIds,
  idEquals,
  idKey,
  type CharId,
  type DeleteOp,
  type InsertOp,
  type Node,
} from "./types";

/**
 * One copy of the document (design section 4).
 *
 * Day 1 scope: local edits only (`localInsert`, `localDelete`, `getText`).
 * Remote apply, the pending buffer and cursor helpers arrive on Days 2-5.
 *
 * All indexes passed in are visible-text positions in UTF-16 code units, the
 * same unit JavaScript strings and CodeMirror use. An index that would fall
 * in the middle of a surrogate pair throws a RangeError.
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

  constructor(replicaId: string) {
    if (replicaId === "") {
      // "" is the replica of ROOT; a real replica using it would collide.
      throw new RangeError("replicaId must be a non-empty string");
    }
    this.replicaId = replicaId;
  }

  /** Visible text: every node that is not a tombstone. */
  getText(): string {
    let out = "";
    for (const node of this.nodes) {
      if (!node.deleted) out += node.char;
    }
    return out;
  }

  /**
   * Type `text` at visible index `index`. Returns the operations to send.
   * Each character becomes one InsertOp whose origin is the previous one
   * (design section 6), so a paste is a chain.
   */
  localInsert(index: number, text: string): InsertOp[] {
    const chars = Array.from(normalizeNewlines(text)); // one entry per code point
    const originId = this.originForVisibleIndex(index);
    const ops: InsertOp[] = [];
    let origin = originId;
    for (const char of chars) {
      this.clock += 1;
      const op: InsertOp = {
        type: "ins",
        id: { clock: this.clock, replica: this.replicaId },
        origin,
        char,
      };
      this.integrate(op);
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

  /**
   * The id a new character typed at visible `index` must use as its origin:
   * the last visible node ending exactly at `index`, or ROOT for index 0.
   */
  private originForVisibleIndex(index: number): CharId {
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
   * The RGA ordering rule (design section 7): start right after the origin and
   * move right past every node with a larger id, then insert.
   *
   * Day 1 only calls this for local inserts, whose origin always exists.
   * Missing-origin handling (the pending buffer) is added on Day 3.
   */
  private integrate(op: InsertOp): void {
    const key = idKey(op.id);
    if (this.seen.has(key)) return; // idempotent

    let pos: number;
    if (idEquals(op.origin, ROOT)) {
      pos = 0;
    } else {
      const originPos = this.index.get(idKey(op.origin));
      if (originPos === undefined) {
        throw new Error(`origin ${idKey(op.origin)} not found (pending buffer arrives on Day 3)`);
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
    this.seen.add(key);
    if (op.id.clock > this.clock) this.clock = op.id.clock;
  }

  /** Test and debug helper: the number of nodes including tombstones. */
  get nodeCount(): number {
    return this.nodes.length;
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
