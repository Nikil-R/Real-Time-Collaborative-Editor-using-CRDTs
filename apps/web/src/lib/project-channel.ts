/**
 * The project's realtime channel: the file list, who is looking at which file,
 * and the activity feed (docs/04-PROTOCOL.md section 8). Editing itself goes over
 * the per-file document sessions; nothing here carries operations.
 */
import type { SocketLike } from "@rce/client";
import type { ActivityEvent, FileInfo } from "./api";
import type { Collaborator } from "./workspace-store";

export type ChannelState = "connecting" | "online" | "offline" | "closed";

export interface ChannelWelcome {
  project: { id: string; name: string };
  files: FileInfo[];
  peers: Collaborator[];
  activity: ActivityEvent[];
}

export interface ChannelHooks {
  onWelcome(w: ChannelWelcome): void;
  onFilesChanged(files: FileInfo[]): void;
  onPeerJoined(c: Collaborator): void;
  onFocus(c: Collaborator): void;
  onPeerLeft(replica: string): void;
  onActivity(e: ActivityEvent): void;
  onState(s: ChannelState, detail?: string): void;
}

export interface ChannelOptions {
  replicaId: string;
  name: string;
  color: string;
  wsUrl: string;
  hooks: ChannelHooks;
  socketFactory?: (url: string) => SocketLike;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  heartbeatMs?: number;
  random?: () => number;
}

const OPEN = 1;

export class ProjectChannel {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = false;
  private offline = false;
  private fatal = false;
  private focused: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ChannelOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = s.onmessage = s.onerror = null;
      try {
        s.close(1000);
      } catch {
        /* already closed */
      }
    }
  }

  /** Tell everyone which file this person has open (null: none). */
  focus(fileId: string | null): void {
    this.focused = fileId;
    this.send({ type: "focus", file_id: fileId });
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    if (offline) {
      const s = this.socket;
      this.socket = null;
      if (s) {
        s.onclose = s.onmessage = s.onerror = null;
        s.close(1000);
      }
      this.clearHeartbeat();
      this.opts.hooks.onState("offline");
    } else if (!this.stopped && !this.fatal && !this.socket) {
      this.attempt = 0;
      this.connect();
    }
  }

  networkBecameAvailable(): void {
    if (this.stopped || this.fatal || this.offline || this.socket) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.fatal || this.offline || this.socket) return;
    this.opts.hooks.onState("connecting");
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
        replica: this.opts.replicaId,
        name: this.opts.name,
        color: this.opts.color,
      });
    };
    sock.onmessage = (ev) => {
      if (this.socket === sock) this.onMessage(String(ev.data));
    };
    sock.onclose = () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.clearHeartbeat();
      if (this.stopped || this.fatal) return;
      this.opts.hooks.onState("offline");
      if (!this.offline) this.scheduleReconnect();
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = this.opts.backoffBaseMs ?? 500;
    const max = this.opts.backoffMaxMs ?? 15_000;
    const rand = this.opts.random ?? Math.random;
    const delay = Math.min(base * 2 ** this.attempt, max) * (0.5 + rand() * 0.5);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(message: Record<string, unknown>): void {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return;
    try {
      s.send(JSON.stringify(message));
    } catch {
      /* the close handler will reconnect */
    }
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const h = this.opts.hooks;
    switch (msg["type"]) {
      case "welcome":
        this.attempt = 0;
        h.onWelcome(msg as unknown as ChannelWelcome);
        h.onState("online");
        this.startHeartbeat();
        if (this.focused !== null) this.send({ type: "focus", file_id: this.focused });
        break;
      case "files_changed":
        h.onFilesChanged(msg["files"] as FileInfo[]);
        break;
      case "peer_joined":
        {
          const c = msg as unknown as Collaborator;
          h.onPeerJoined({ ...c, file_id: c.file_id ?? null });
        }
        break;
      case "focus":
        h.onFocus(msg as unknown as Collaborator);
        break;
      case "peer_left":
        h.onPeerLeft(String(msg["replica"]));
        break;
      case "activity":
        h.onActivity(msg["event"] as ActivityEvent);
        break;
      case "error": {
        const code = String(msg["code"]);
        if (code === "DOC_NOT_FOUND" || code === "REPLICA_IN_USE") {
          this.fatal = true;
          h.onState("closed", `${code}: ${String(msg["message"])}`);
        }
        break;
      }
      default:
        break;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(
      () => this.send({ type: "ping", t: Date.now() }),
      this.opts.heartbeatMs ?? 20_000,
    );
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
