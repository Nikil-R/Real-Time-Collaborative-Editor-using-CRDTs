/**
 * Core data types for the RGA CRDT. See docs/03-CRDT-DESIGN.md sections 3-5.
 * Pure types and tiny helpers only: no DOM, no Node APIs, no dependencies.
 */

/** Permanent identity of one character: (Lamport clock, replica id). */
export interface CharId {
  readonly clock: number;
  readonly replica: string;
}

/** Stands for "the start of the document". Smaller than every real id. */
export const ROOT: CharId = Object.freeze({ clock: 0, replica: "" });

/** Unique id of a delete operation, used for server-side de-duplication. */
export interface OpId {
  readonly replica: string;
  readonly counter: number;
}

export interface InsertOp {
  readonly type: "ins";
  readonly id: CharId;
  /** The character this one was typed directly after (ROOT for the start). */
  readonly origin: CharId;
  /** One code point (a surrogate pair is a single node of length 2). */
  readonly char: string;
}

export interface DeleteOp {
  readonly type: "del";
  readonly target: CharId;
  readonly opId: OpId;
}

export type Op = InsertOp | DeleteOp;

/** One character in the sequence. `deleted` makes it a tombstone. */
export interface Node {
  readonly id: CharId;
  readonly char: string;
  deleted: boolean;
}

/**
 * A change to the visible text, in the coordinates of the text as it is just
 * before this change is applied. Apply a list of them in order. Matches the
 * shape CodeMirror 6 accepts for `view.dispatch({ changes })`.
 */
export interface Change {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * Total order on ids (design section 3):
 * 1. higher clock is greater;
 * 2. equal clocks: higher replica string is greater (plain string comparison).
 * Returns a negative number, zero, or a positive number.
 */
export function compareIds(a: CharId, b: CharId): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}

export function idEquals(a: CharId, b: CharId): boolean {
  return a.clock === b.clock && a.replica === b.replica;
}

/** Map key for an id: clock + "@" + replica. */
export function idKey(id: CharId): string {
  return `${id.clock}@${id.replica}`;
}

/** Map key for a delete operation id. */
export function opIdKey(id: OpId): string {
  return `${id.replica}#${id.counter}`;
}
