/**
 * Conversion between CRDT operations and the JSON shape of docs/04-PROTOCOL.md.
 * Pure functions, no I/O. The server never calls this: it stores wire ops as
 * opaque JSON. Only clients (browser, load test) convert.
 */
import type { CharId, DeleteOp, InsertOp, Op } from "./types";

export interface WireId {
  c: number;
  r: string;
}

/** Sender-assigned id of one message operation, used for de-duplication. */
export interface WireOpId {
  r: string;
  n: number;
}

export type WireOp =
  | { op_id: WireOpId; kind: "ins"; id: WireId; origin: WireId; ch: string }
  | { op_id: WireOpId; kind: "del"; target: WireId };

export function idToWire(id: CharId): WireId {
  return { c: id.clock, r: id.replica };
}

export function idFromWire(w: WireId): CharId {
  return { clock: w.c, replica: w.r };
}

/**
 * Convert a CRDT op to a wire op. `opId` is the per-replica sequence number
 * assigned when the op is queued for sending (see the client outbox).
 */
export function toWire(op: Op, opId: WireOpId): WireOp {
  if (op.type === "ins") {
    return { op_id: opId, kind: "ins", id: idToWire(op.id), origin: idToWire(op.origin), ch: op.char };
  }
  return { op_id: opId, kind: "del", target: idToWire(op.target) };
}

/** Parse and validate a wire op. Throws TypeError on any malformed field. */
export function fromWire(w: unknown): Op {
  if (typeof w !== "object" || w === null) throw new TypeError("wire op must be an object");
  const o = w as Record<string, unknown>;
  const opId = parseOpId(o["op_id"]);
  if (o["kind"] === "ins") {
    const ch = o["ch"];
    if (typeof ch !== "string" || ch.length < 1 || ch.length > 2) {
      throw new TypeError("ins.ch must be one code point");
    }
    const op: InsertOp = {
      type: "ins",
      id: parseId(o["id"], "id"),
      origin: parseId(o["origin"], "origin"),
      char: ch,
    };
    return op;
  }
  if (o["kind"] === "del") {
    const op: DeleteOp = {
      type: "del",
      target: parseId(o["target"], "target"),
      opId: { replica: opId.r, counter: opId.n },
    };
    return op;
  }
  throw new TypeError(`unknown op kind ${String(o["kind"])}`);
}

function parseId(v: unknown, name: string): CharId {
  if (typeof v !== "object" || v === null) throw new TypeError(`${name} must be an object`);
  const o = v as Record<string, unknown>;
  const c = o["c"];
  const r = o["r"];
  if (typeof c !== "number" || !Number.isInteger(c) || c < 0) throw new TypeError(`${name}.c invalid`);
  if (typeof r !== "string") throw new TypeError(`${name}.r invalid`);
  return { clock: c, replica: r };
}

function parseOpId(v: unknown): WireOpId {
  if (typeof v !== "object" || v === null) throw new TypeError("op_id must be an object");
  const o = v as Record<string, unknown>;
  const n = o["n"];
  const r = o["r"];
  if (typeof r !== "string" || r === "") throw new TypeError("op_id.r invalid");
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new TypeError("op_id.n invalid");
  return { r, n };
}
