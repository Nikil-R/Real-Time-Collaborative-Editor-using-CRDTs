/**
 * DocSession: one open document in one editor (browser tab or simulated user).
 *
 * Owns a CRDT `Replica`, the outbox of unacknowledged operations, and the
 * WebSocket connection (docs/04-PROTOCOL.md). Framework agnostic: the socket
 * and the persistent store are injected, so it runs in tests and in Node.
 *
 * Flow of a keystroke: `localEdit` -> replica -> outbox (persisted first) ->
 * batched `ops` message -> `ack` removes it from the outbox.
 * Flow of a remote edit: `ops` message -> `replica.applyRemote` -> hooks.
 */
import {
  Replica,
  fromWire,
  idToWire,
  toWire,
  type Change,
  type Op,
  type WireId,
  type WireOp,
} from "@rce/crdt";
import { SeqTracker } from "./seq";
import type { LocalStore } from "./store";

export type Status = "loading" | "connecting" | "online" | "offline" | "closed";

export interface Peer {
  replica: string;
  name: string;
  color: string;
}

export interface PeerPresence extends Peer {
  anchor: WireId | null;
  head: WireId | null;
}

/** The subset of the browser WebSocket API the session uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SessionHooks {
  /** Visible-text changes caused by remote operations, in order. */
  onRemoteChanges?(changes: Change[]): void;
  /** The whole text was replaced (initial load from cache, or a snapshot). */
  onReset?(text: string): void;
  onStatus?(status: Status, detail?: string): void;
  onPeers?(peers: Peer[]): void;
  onPresence?(presence: PeerPresence): void;
  onPeerLeft?(replica: string): void;
  onError?(code: string, message: string): void;
  /** Called after each remote or local change, for UI counters. */
  onActivity?(): void;
}

export interface SessionConfig {
  batchIntervalMs: number;
  maxOpsPerBatch: number;
  heartbeatMs: number;
  pongTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  gapTimeoutMs: number;
  retryAfterErrorMs: number;
  snapshotEvery: number;
  stateSaveMs: number;
  presenceMs: number;
  random: () => number;
}

export const DEFAULT_CONFIG: SessionConfig = {
  batchIntervalMs: 30,
  maxOpsPerBatch: 500,
  heartbeatMs: 20_000,
  pongTimeoutMs: 10_000,
  backoffBaseMs: 500,
  backoffMaxMs: 15_000,
  gapTimeoutMs: 1_000,
  retryAfterErrorMs: 1_000,
  snapshotEvery: 2_000,
  stateSaveMs: 2_000,
  presenceMs: 50,
  random: Math.random,
};

export interface SessionOptions {
  docId: string;
  replicaId: string;
  name: string;
  color: string;
  /** Full WebSocket URL, e.g. ws://localhost:8000/ws/<docId>. */
  wsUrl: string;
  store: LocalStore;
  socketFactory?: (url: string) => SocketLike;
  hooks?: SessionHooks;
  config?: Partial<SessionConfig>;
}

type ServerOp = WireOp & { seq: number };

const OPEN = 1;

export class DocSession {
  readonly docId: string;
  readonly replicaId: string;
  private opts: SessionOptions;
  private cfg: SessionConfig;
  private hooks: SessionHooks;

  private replica: Replica;
  private tracker = new SeqTracker(0);
  private outbox: WireOp[] = [];
  private nextOpN = 1;

  private socket: SocketLike | null = null;
  private _status: Status = "loading";
  private attempt = 0;
  private stopped = false;
  private manualOffline = false;
  private fatal = false;

  private inflight = new Map<string, number[]>();
  private inflightNs = new Set<number>();
  private batchCounter = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;

  private latestPresence: { anchor: WireId | null; head: WireId | null } | null = null;
  private lastPresenceSent = "";
  private opsSinceSnapshot = 0;
  private peers = new Map<string, Peer>();
  private lastHeadSeq = 0;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.docId = opts.docId;
    this.replicaId = opts.replicaId;
    this.cfg = { ...DEFAULT_CONFIG, ...opts.config };
    this.hooks = opts.hooks ?? {};
    this.replica = new Replica(opts.replicaId);
  }

  // ------------------------------------------------------------- accessors

  get status(): Status {
    return this._status;
  }
  get text(): string {
    return this.replica.getText();
  }
  /** The live replica (read-only use: cursors, debug panel). */
  get doc(): Replica {
    return this.replica;
  }
  get outboxSize(): number {
    return this.outbox.length;
  }
  get lastSeq(): number {
    return this.tracker.value;
  }
  get headSeq(): number {
    return this.lastHeadSeq;
  }
  get peerList(): Peer[] {
    return [...this.peers.values()];
  }

  // ------------------------------------------------------------- lifecycle

  /** Load persisted data, show it, then connect. */
  async start(): Promise<void> {
    const saved = await this.opts.store.load();
    if (saved.state) {
      this.replica = Replica.fromState(saved.state, this.replicaId);
      this.tracker = new SeqTracker(saved.lastSeq);
    }
    this.outbox = [...saved.outbox].sort((a, b) => a.op_id.n - b.op_id.n);
    const maxN = this.outbox.reduce((m, o) => Math.max(m, o.op_id.n), 0);
    this.nextOpN = Math.max(saved.nextOpN, maxN + 1);
    // Unsent local edits are part of the document the user sees (U6).
    const own: Op[] = [];
    for (const w of this.outbox) {
      try {
        own.push(fromWire(w));
      } catch {
        /* a corrupt entry cannot be applied; the server would reject it too */
      }
    }
    this.replica.applyRemote(own);
    this.hooks.onReset?.(this.replica.getText());
    this.hooks.onActivity?.();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      sock.onclose = null;
      sock.onmessage = null;
      sock.onerror = null;
      try {
        sock.close(1000);
      } catch {
        /* already closed */
      }
    }
    await this.opts.store.saveState(this.replica.getState(), this.tracker.value);
    this.setStatus("closed");
  }

  /** Simulate losing the network (demo and tests): no reconnect until cleared. */
  setOfflineMode(offline: boolean): void {
    this.manualOffline = offline;
    if (offline) {
      this.dropSocket();
    } else if (!this.stopped && !this.fatal && !this.socket) {
      this.attempt = 0;
      this.connect();
    }
  }

  /** The browser reported the network is back: reconnect without waiting. */
  networkBecameAvailable(): void {
    if (this.stopped || this.fatal || this.manualOffline || this.socket) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.connect();
  }

  // --------------------------------------------------------------- editing

  /**
   * Apply the user's edit. `changes` are sequential: each one is expressed in
   * the text as it is after the previous one (the editor binding builds them).
   */
  localEdit(changes: readonly Change[]): void {
    const ops: Op[] = [];
    for (const c of changes) {
      if (c.to > c.from) ops.push(...this.replica.localDelete(c.from, c.to - c.from));
      if (c.insert) ops.push(...this.replica.localInsert(c.from, c.insert));
    }
    if (ops.length === 0) return;
    const wire = ops.map((op) => toWire(op, { r: this.replicaId, n: this.nextOpN++ }));
    this.outbox.push(...wire);
    // Persist BEFORE sending: a reload or crash must not lose acknowledged-looking typing.
    void this.opts.store.addToOutbox(wire, this.nextOpN);
    this.scheduleFlush();
    this.scheduleStateSave();
    this.hooks.onActivity?.();
  }

  /** Report the local cursor/selection as visible indexes. */
  setCursor(anchor: number, head: number): void {
    let a: WireId | null;
    let h: WireId | null;
    try {
      a = this.toWireCursor(anchor);
      h = this.toWireCursor(head);
    } catch {
      return; // an index inside a surrogate pair: skip this update
    }
    this.latestPresence = { anchor: a, head: h };
    this.schedulePresence();
  }

  /** Resolve a cursor id received from a peer to a visible index (-1 if unknown yet). */
  indexOfCursor(id: WireId | null): number {
    if (id === null) return 0;
    return this.replica.indexOfId({ clock: id.c, replica: id.r });
  }

  private toWireCursor(index: number): WireId | null {
    const id = this.replica.idAtIndex(index);
    return id.clock === 0 ? null : idToWire(id);
  }

  // ------------------------------------------------------------ connection

  private connect(): void {
    if (this.stopped || this.fatal || this.manualOffline || this.socket) return;
    this.setStatus("connecting");
    let sock: SocketLike;
    try {
      sock = this.opts.socketFactory
        ? this.opts.socketFactory(this.opts.wsUrl)
        : (new WebSocket(this.opts.wsUrl) as unknown as SocketLike);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    sock.onopen = () => {
      if (this.socket !== sock) return;
      this.send({
        type: "hello",
        v: 1,
        last_seq: this.tracker.value,
        replica: this.replicaId,
        name: this.opts.name,
        color: this.opts.color,
      });
    };
    sock.onmessage = (ev) => {
      if (this.socket !== sock) return;
      this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    sock.onclose = () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.onDisconnected();
    };
    sock.onerror = () => {
      /* onclose follows; nothing to do here */
    };
  }

  private dropSocket(): void {
    const sock = this.socket;
    if (!sock) {
      this.onDisconnected();
      return;
    }
    this.socket = null;
    sock.onclose = null;
    sock.onmessage = null;
    sock.onerror = null;
    try {
      sock.close(1000);
    } catch {
      /* ignore */
    }
    this.onDisconnected();
  }

  private onDisconnected(): void {
    this.clearConnectionTimers();
    this.inflightNs.clear(); // unacked batches will be re-sent after reconnecting
    this.peers.clear();
    this.hooks.onPeers?.([]);
    if (this.stopped || this.fatal) return;
    this.setStatus("offline");
    if (!this.manualOffline) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const raw = Math.min(this.cfg.backoffBaseMs * 2 ** this.attempt, this.cfg.backoffMaxMs);
    const delay = raw * (0.5 + this.cfg.random() * 0.5); // jitter
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Delay used for the next reconnect attempt, without jitter (for tests). */
  static backoffFor(attempt: number, cfg: Pick<SessionConfig, "backoffBaseMs" | "backoffMaxMs">): number {
    return Math.min(cfg.backoffBaseMs * 2 ** attempt, cfg.backoffMaxMs);
  }

  private send(message: Record<string, unknown>): boolean {
    const sock = this.socket;
    if (!sock || sock.readyState !== OPEN) return false;
    try {
      sock.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------- messages

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg["type"]) {
      case "welcome":
        this.onWelcome(msg);
        break;
      case "ops":
        this.applyServerOps(msg["ops"] as ServerOp[]);
        break;
      case "catchup":
        this.onCatchup(msg);
        break;
      case "ack":
        this.onAck(String(msg["batch_id"]), (msg["seqs"] as number[] | undefined) ?? []);
        break;
      case "presence":
        this.hooks.onPresence?.(msg as unknown as PeerPresence);
        break;
      case "peer_joined": {
        const p = msg as unknown as Peer;
        if (p.replica !== this.replicaId) {
          this.peers.set(p.replica, { replica: p.replica, name: p.name, color: p.color });
          this.hooks.onPeers?.(this.peerList);
          if (this.latestPresence) this.lastPresenceSent = ""; // tell the newcomer where we are
          this.schedulePresence();
        }
        break;
      }
      case "peer_left":
        this.peers.delete(String(msg["replica"]));
        this.hooks.onPeerLeft?.(String(msg["replica"]));
        this.hooks.onPeers?.(this.peerList);
        break;
      case "pong": {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        // The server reports its head seq: if we are behind (a broadcast was
        // lost and nothing newer arrived to reveal the hole), catch up now.
        const head = Number(msg["head_seq"] ?? 0);
        if (head > this.lastHeadSeq) this.lastHeadSeq = head;
        if (head > this.tracker.value) this.send({ type: "sync", last_seq: this.tracker.value });
        break;
      }
      case "error":
        this.onServerError(String(msg["code"]), String(msg["message"]));
        break;
      default:
        break;
    }
  }

  private onWelcome(msg: Record<string, unknown>): void {
    const snapshot = msg["snapshot"] as { up_to_seq: number; state: never } | null;
    if (snapshot && snapshot.up_to_seq > this.tracker.value) this.applySnapshot(snapshot);
    this.lastHeadSeq = Number(msg["head_seq"] ?? 0);
    this.applyServerOps(msg["ops_since"] as ServerOp[]);
    this.peers.clear();
    for (const p of (msg["peers"] as Peer[]) ?? []) this.peers.set(p.replica, p);
    this.hooks.onPeers?.(this.peerList);
    this.attempt = 0;
    this.setStatus("online");
    this.startHeartbeat();
    if (msg["more"]) this.send({ type: "sync", last_seq: this.tracker.value });
    // Everything unacknowledged is (re)sent on every new connection.
    this.inflightNs.clear();
    this.flush();
    this.lastPresenceSent = "";
    this.schedulePresence();
  }

  private onCatchup(msg: Record<string, unknown>): void {
    this.lastHeadSeq = Number(msg["head_seq"] ?? this.lastHeadSeq);
    this.applyServerOps(msg["ops"] as ServerOp[]);
    if (msg["more"]) this.send({ type: "sync", last_seq: this.tracker.value });
  }

  private applySnapshot(snapshot: { up_to_seq: number; state: never }): void {
    // Rebuild from the snapshot, then put our own unacknowledged edits back on top.
    const replica = Replica.fromState(snapshot.state, this.replicaId);
    const own: Op[] = [];
    for (const w of this.outbox) {
      try {
        own.push(fromWire(w));
      } catch {
        /* skip corrupt entry */
      }
    }
    replica.applyRemote(own);
    this.replica = replica;
    this.tracker.advanceTo(snapshot.up_to_seq);
    this.hooks.onReset?.(replica.getText());
    this.hooks.onActivity?.();
    this.scheduleStateSave();
  }

  private applyServerOps(list: ServerOp[]): void {
    if (!list || list.length === 0) return;
    const ops: Op[] = [];
    for (const w of list) {
      this.tracker.observe(w.seq);
      try {
        ops.push(fromWire(w));
      } catch {
        this.hooks.onError?.("BAD_OP", "ignored a malformed operation from the server");
      }
    }
    const changes = this.replica.applyRemote(ops);
    if (changes.length > 0) this.hooks.onRemoteChanges?.(changes);
    this.opsSinceSnapshot += ops.length;
    this.scheduleStateSave();
    this.checkForGap();
    this.maybeUploadSnapshot();
    this.hooks.onActivity?.();
  }

  private onAck(batchId: string, seqs: number[]): void {
    // Our own ops are never echoed back: learn their seq numbers from the ack.
    for (const s of seqs) this.tracker.observe(s);
    this.opsSinceSnapshot += seqs.length;
    const ns = this.inflight.get(batchId);
    if (!ns) return;
    this.inflight.delete(batchId);
    const done = new Set(ns);
    this.outbox = this.outbox.filter((o) => !done.has(o.op_id.n));
    for (const n of ns) this.inflightNs.delete(n);
    void this.opts.store.removeFromOutbox(ns);
    if (this.outbox.length > 0) this.scheduleFlush();
    this.maybeUploadSnapshot();
    this.hooks.onActivity?.();
  }

  private onServerError(code: string, message: string): void {
    this.hooks.onError?.(code, message);
    if (code === "DOC_NOT_FOUND" || code === "REPLICA_IN_USE") {
      this.fatal = true;
      this.clearTimers();
      this.setStatus("closed", `${code}: ${message}`);
      const sock = this.socket;
      this.socket = null;
      sock?.close(1000);
      return;
    }
    if (code === "RATE_LIMITED" || code === "INTERNAL") {
      // The batch was not stored. Forget what is "in flight" and try again soon.
      this.inflightNs.clear();
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.cfg.retryAfterErrorMs);
    }
  }

  // ------------------------------------------------------------- outbox

  private scheduleFlush(): void {
    if (this.flushTimer || this._status !== "online") return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.cfg.batchIntervalMs);
  }

  private flush(): void {
    if (this._status !== "online") return;
    const unsent = this.outbox.filter((o) => !this.inflightNs.has(o.op_id.n));
    for (let i = 0; i < unsent.length; i += this.cfg.maxOpsPerBatch) {
      const chunk = unsent.slice(i, i + this.cfg.maxOpsPerBatch);
      const batchId = `${this.replicaId}-${++this.batchCounter}`;
      if (!this.send({ type: "ops", batch_id: batchId, ops: chunk })) return;
      const ns = chunk.map((o) => o.op_id.n);
      this.inflight.set(batchId, ns);
      for (const n of ns) this.inflightNs.add(n);
    }
  }

  // ---------------------------------------------------------- housekeeping

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.send({ type: "ping", t: Date.now() })) return;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        // No pong: the connection is dead even if the browser has not noticed.
        this.pongTimer = null;
        this.dropSocket();
      }, this.cfg.pongTimeoutMs);
    }, this.cfg.heartbeatMs);
  }

  private checkForGap(): void {
    if (!this.tracker.hasGap) {
      if (this.gapTimer) clearTimeout(this.gapTimer);
      this.gapTimer = null;
      return;
    }
    if (this.gapTimer) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.tracker.hasGap) {
        this.send({ type: "sync", last_seq: this.tracker.value });
        this.checkForGap();
      }
    }, this.cfg.gapTimeoutMs);
  }

  private maybeUploadSnapshot(): void {
    if (
      this._status !== "online" ||
      this.outbox.length > 0 ||
      this.tracker.hasGap ||
      this.opsSinceSnapshot < this.cfg.snapshotEvery ||
      this.tracker.value === 0
    ) {
      return;
    }
    if (
      this.send({
        type: "snapshot",
        up_to_seq: this.tracker.value,
        state: this.replica.getState(),
      })
    ) {
      this.opsSinceSnapshot = 0;
    }
  }

  private schedulePresence(): void {
    if (this.presenceTimer || this._status !== "online" || !this.latestPresence) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (!this.latestPresence) return;
      const body = JSON.stringify(this.latestPresence);
      if (body === this.lastPresenceSent) return;
      if (this.send({ type: "presence", ...this.latestPresence })) this.lastPresenceSent = body;
    }, this.cfg.presenceMs);
  }

  private scheduleStateSave(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.opts.store.saveState(this.replica.getState(), this.tracker.value);
    }, this.cfg.stateSaveMs);
  }

  private setStatus(status: Status, detail?: string): void {
    if (this._status === status && detail === undefined) return;
    this._status = status;
    this.hooks.onStatus?.(status, detail);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
  }

  private clearConnectionTimers(): void {
    this.clearHeartbeat();
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.gapTimer = null;
    this.flushTimer = null;
    this.presenceTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectionTimers();
    for (const t of [this.reconnectTimer, this.stateTimer]) if (t) clearTimeout(t);
    this.reconnectTimer = null;
    this.stateTimer = null;
  }
}
