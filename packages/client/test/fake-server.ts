/**
 * In-memory stand-in for the Python server, following docs/04-PROTOCOL.md:
 * gap-free seq, de-duplication by (replica, counter), welcome with snapshot and
 * paging, ack, broadcast, presence relay. Used to test DocSession without a
 * network. Fault hooks let tests drop connections and reorder or lose broadcasts.
 */
import type { SocketLike } from "../src/index";

type Json = Record<string, unknown>;

interface StoredOp {
  seq: number;
  payload: Json;
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  replica = "";
  helloDone = false;
  sent: Json[] = [];

  constructor(readonly server: FakeServer) {}

  send(data: string): void {
    const msg = JSON.parse(data) as Json;
    this.sent.push(msg);
    this.server.receive(this, msg);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.disconnected(this);
    setTimeout(() => this.onclose?.({}), 0);
  }

  /** Called by the server to push a message to the client. */
  push(msg: Json): void {
    if (this.readyState !== 1) return;
    const delay = this.server.latency();
    setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) });
    }, delay);
  }

  /** Server-initiated close (network failure). */
  kill(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.disconnected(this);
    setTimeout(() => this.onclose?.({}), 0);
  }
}

export class FakeServer {
  ops: StoredOp[] = [];
  snapshot: { up_to_seq: number; state: unknown } | null = null;
  sockets = new Set<FakeSocket>();
  pageSize = 5000;
  /** Test knobs. */
  latencyMs = 1;
  respondToPing = true;
  failNextOps: string | null = null; // error code to answer the next ops batch with
  /** Decide how a stored batch reaches one other client: deliver, drop, or reorder. */
  broadcastFilter: ((target: FakeSocket, ops: Json[]) => Json[][]) | null = null;
  acceptedBatches = 0;
  connections = 0;

  private index = new Map<string, number>();

  latency(): number {
    return this.latencyMs;
  }

  /** Socket factory for DocSession. */
  factory = (_url: string): FakeSocket => {
    const sock = new FakeSocket(this);
    this.connections += 1;
    setTimeout(() => {
      if (sock.readyState === 0) {
        sock.readyState = 1;
        this.sockets.add(sock);
        sock.onopen?.({});
      }
    }, this.latencyMs);
    return sock;
  };

  get head(): number {
    return this.ops.length;
  }

  disconnected(sock: FakeSocket): void {
    this.sockets.delete(sock);
    if (sock.helloDone) {
      for (const other of this.sockets) other.push({ type: "peer_left", replica: sock.replica });
    }
  }

  dropAll(): void {
    for (const s of [...this.sockets]) s.kill();
  }

  receive(sock: FakeSocket, msg: Json): void {
    switch (msg["type"]) {
      case "hello":
        this.onHello(sock, msg);
        break;
      case "ops":
        this.onOps(sock, msg);
        break;
      case "sync":
        sock.push({
          type: "catchup",
          ...this.page(Number(msg["last_seq"])),
          head_seq: this.head,
        });
        break;
      case "ping":
        if (this.respondToPing) sock.push({ type: "pong", t: msg["t"], head_seq: this.head });
        break;
      case "presence":
        for (const other of this.sockets) {
          if (other !== sock) {
            other.push({ type: "presence", replica: sock.replica, name: "n", color: "#fff", ...msg });
          }
        }
        break;
      case "snapshot": {
        const seq = Number(msg["up_to_seq"]);
        if (seq <= this.head && (!this.snapshot || seq > this.snapshot.up_to_seq)) {
          this.snapshot = { up_to_seq: seq, state: msg["state"] };
        }
        break;
      }
      default:
        break;
    }
  }

  private page(since: number): { ops: Json[]; more: boolean } {
    const rest = this.ops.filter((o) => o.seq > since);
    const page = rest.slice(0, this.pageSize);
    return {
      ops: page.map((o) => ({ ...o.payload, seq: o.seq })),
      more: rest.length > page.length,
    };
  }

  private onHello(sock: FakeSocket, msg: Json): void {
    const replica = String(msg["replica"]);
    if ([...this.sockets].some((s) => s !== sock && s.helloDone && s.replica === replica)) {
      sock.push({ type: "error", code: "REPLICA_IN_USE", message: "in use" });
      return;
    }
    sock.replica = replica;
    sock.helloDone = true;
    const lastSeq = Number(msg["last_seq"]);
    let since = lastSeq;
    let snapshot: unknown = null;
    if (this.snapshot && this.snapshot.up_to_seq > lastSeq && lastSeq === 0) {
      snapshot = this.snapshot;
      since = this.snapshot.up_to_seq;
    }
    const { ops, more } = this.page(since);
    sock.push({
      type: "welcome",
      doc_id: "doc",
      snapshot,
      ops_since: ops,
      more,
      head_seq: this.head,
      peers: [...this.sockets]
        .filter((s) => s !== sock && s.helloDone)
        .map((s) => ({ replica: s.replica, name: "n", color: "#fff" })),
    });
    for (const other of this.sockets) {
      if (other !== sock && other.helloDone) {
        other.push({ type: "peer_joined", replica, name: String(msg["name"]), color: "#fff" });
      }
    }
  }

  private onOps(sock: FakeSocket, msg: Json): void {
    if (this.failNextOps) {
      const code = this.failNextOps;
      this.failNextOps = null;
      sock.push({ type: "error", code, message: "injected" });
      return;
    }
    const incoming = msg["ops"] as Json[];
    const fresh: Json[] = [];
    const seqs: number[] = [];
    let maxSeq = 0;
    for (const op of incoming) {
      const id = op["op_id"] as { r: string; n: number };
      const key = `${id.r}#${id.n}`;
      const existing = this.index.get(key);
      if (existing !== undefined) {
        maxSeq = Math.max(maxSeq, existing);
        seqs.push(existing);
        continue;
      }
      const seq = this.ops.length + 1; // gap-free
      this.ops.push({ seq, payload: op });
      this.index.set(key, seq);
      fresh.push({ ...op, seq });
      seqs.push(seq);
      maxSeq = Math.max(maxSeq, seq);
    }
    this.acceptedBatches += 1;
    sock.push({ type: "ack", batch_id: msg["batch_id"], max_seq: maxSeq, seqs });
    if (fresh.length === 0) return;
    for (const other of this.sockets) {
      if (other === sock || !other.helloDone) continue;
      const groups = this.broadcastFilter ? this.broadcastFilter(other, fresh) : [fresh];
      for (const g of groups) if (g.length) other.push({ type: "ops", ops: g });
    }
  }
}
