/**
 * Fault injector for chaos runs (docs/07-TESTING.md section 7). Wraps a
 * client's socket and, on messages arriving from the server, randomly
 * drops the connection, delays, duplicates or reorders them.
 */
import type { SocketLike } from "@rce/client";

export interface FaultConfig {
  /** Probability per received message that the connection is cut. */
  dropProb: number;
  /** Probability a message is delayed (this also reorders it). */
  delayProb: number;
  maxDelayMs: number;
  dupProb: number;
}

export interface FaultCounters {
  dropped: number;
  delayed: number;
  duplicated: number;
}

export interface FaultSwitch {
  active: boolean;
}

class FaultySocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(
    private readonly inner: SocketLike,
    private readonly cfg: FaultConfig,
    private readonly sw: FaultSwitch,
    private readonly counters: FaultCounters,
    private readonly rand: () => number,
  ) {
    inner.onopen = (ev) => this.onopen?.(ev);
    inner.onclose = (ev) => this.onclose?.(ev);
    inner.onerror = (ev) => this.onerror?.(ev);
    inner.onmessage = (ev) => this.receive(ev);
  }

  get readyState(): number {
    return this.inner.readyState;
  }
  send(data: string): void {
    this.inner.send(data);
  }
  close(code?: number): void {
    this.inner.close(code);
  }

  private deliver(ev: { data: unknown }): void {
    this.onmessage?.(ev);
  }

  private receive(ev: { data: unknown }): void {
    if (!this.sw.active) {
      this.deliver(ev);
      return;
    }
    if (this.rand() < this.cfg.dropProb) {
      this.counters.dropped += 1;
      this.inner.close(); // the session sees onclose and reconnects
      return;
    }
    if (this.rand() < this.cfg.dupProb) {
      this.counters.duplicated += 1;
      this.deliver(ev);
    }
    if (this.rand() < this.cfg.delayProb) {
      this.counters.delayed += 1;
      setTimeout(() => this.deliver(ev), this.rand() * this.cfg.maxDelayMs);
      return;
    }
    this.deliver(ev);
  }
}

export function faultySocketFactory(
  base: (url: string) => SocketLike,
  cfg: FaultConfig,
  sw: FaultSwitch,
  counters: FaultCounters,
  rand: () => number,
): (url: string) => SocketLike {
  return (url) => new FaultySocket(base(url), cfg, sw, counters, rand);
}
