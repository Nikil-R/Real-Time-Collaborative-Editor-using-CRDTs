import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocSession, MemoryStore, SeqTracker, type SessionConfig, type Status } from "../src/index";
import { FakeServer } from "./fake-server";

const FAST: Partial<SessionConfig> = {
  batchIntervalMs: 5,
  stateSaveMs: 50,
  presenceMs: 5,
  gapTimeoutMs: 200,
  backoffBaseMs: 100,
  backoffMaxMs: 800,
  retryAfterErrorMs: 100,
  heartbeatMs: 1000,
  pongTimeoutMs: 500,
  random: () => 1, // no jitter reduction: delay = full backoff
};

interface Client {
  session: DocSession;
  store: MemoryStore;
  statuses: Status[];
  remote: string[];
  errors: string[];
}

function makeClient(
  server: FakeServer,
  replicaId: string,
  opts: { store?: MemoryStore; config?: Partial<SessionConfig> } = {},
): Client {
  const store = opts.store ?? new MemoryStore();
  const statuses: Status[] = [];
  const remote: string[] = [];
  const errors: string[] = [];
  const session = new DocSession({
    docId: "doc",
    replicaId,
    name: replicaId,
    color: "#abcdef",
    wsUrl: "ws://fake/ws/doc",
    store,
    socketFactory: server.factory,
    config: { ...FAST, ...opts.config },
    hooks: {
      onStatus: (s) => statuses.push(s),
      onRemoteChanges: (c) => remote.push(JSON.stringify(c)),
      onError: (code) => errors.push(code),
    },
  });
  return { session, store, statuses, remote, errors };
}

const settle = async (ms = 100): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

async function typeText(c: Client, text: string, at = c.session.text.length): Promise<void> {
  c.session.localEdit([{ from: at, to: at, insert: text }]);
  await settle(50);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SeqTracker", () => {
  it("advances over contiguous seqs and remembers out-of-order ones", () => {
    const t = new SeqTracker();
    t.observe(1);
    t.observe(3);
    expect(t.value).toBe(1);
    expect(t.hasGap).toBe(true);
    t.observe(2);
    expect(t.value).toBe(3);
    expect(t.hasGap).toBe(false);
  });
  it("ignores duplicates and old numbers, and snapshots jump forward", () => {
    const t = new SeqTracker();
    t.observe(1);
    t.observe(1);
    t.observe(5);
    t.advanceTo(7);
    expect(t.value).toBe(7);
    expect(t.hasGap).toBe(false);
    t.observe(8);
    expect(t.value).toBe(8);
    expect(t.highestSeen).toBe(8);
  });
});

describe("DocSession", () => {
  it("connects with hello carrying v, replica and last_seq 0", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    await a.session.start();
    await settle();
    expect(a.session.status).toBe("online");
    const hello = [...server.sockets][0]!.sent[0]!;
    expect(hello).toMatchObject({ type: "hello", v: 1, last_seq: 0, replica: "r-a" });
  });

  it("sends local edits, receives an ack and empties the outbox", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    await a.session.start();
    await settle();
    await typeText(a, "hello");
    expect(server.head).toBe(5);
    expect(a.session.outboxSize).toBe(0);
    expect((await a.store.load()).outbox).toEqual([]);
  });

  it("persists an edit to the store before it is acknowledged", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    await a.session.start();
    a.session.localEdit([{ from: 0, to: 0, insert: "hi" }]); // still offline: not connected yet
    expect((await a.store.load()).outbox).toHaveLength(2);
  });

  it("two sessions converge through the server", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    const b = makeClient(server, "r-b");
    await a.session.start();
    await b.session.start();
    await settle();
    await typeText(a, "Hello");
    await typeText(b, " world");
    await typeText(a, "!", 0);
    await settle(200);
    expect(a.session.text).toBe(b.session.text);
    expect(a.session.text).toContain("Hello");
    expect(a.session.text).toContain("world");
    expect(b.remote.length).toBeGreaterThan(0);
  });

  it("concurrent edits at the same position converge", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    const b = makeClient(server, "r-b");
    await a.session.start();
    await b.session.start();
    await settle();
    await typeText(a, "CAT");
    await settle(100);
    server.latencyMs = 50;
    a.session.localEdit([{ from: 2, to: 2, insert: "R" }]);
    b.session.localEdit([{ from: 2, to: 2, insert: "S" }]);
    await settle(500);
    expect(a.session.text).toBe(b.session.text);
    expect(a.session.text).toBe("CASRT"); // Priya/Rahul rule: r-a < r-b
  });

  it("keeps typing while offline and merges everything after reconnecting", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    const b = makeClient(server, "r-b");
    await a.session.start();
    await b.session.start();
    await settle();
    await typeText(a, "base ");
    await settle(100);

    b.session.setOfflineMode(true);
    await settle(50);
    expect(b.session.status).toBe("offline");
    await typeText(b, "offline-B");
    await typeText(a, "online-A");
    expect(b.session.outboxSize).toBe("offline-B".length);
    expect(b.session.text).toContain("offline-B"); // typing never blocks

    b.session.setOfflineMode(false);
    await settle(500);
    expect(b.session.status).toBe("online");
    expect(b.session.outboxSize).toBe(0);
    expect(a.session.text).toBe(b.session.text);
    expect(a.session.text).toContain("offline-B");
    expect(a.session.text).toContain("online-A");
  });

  it("reconnects with exponential backoff capped at the maximum", async () => {
    const server = new FakeServer();
    const attempts: number[] = [];
    let blocked = false;
    const a = makeClient(server, "r-a");
    const original = server.factory;
    (a.session as unknown as { opts: { socketFactory: unknown } }).opts.socketFactory = (
      url: string,
    ) => {
      attempts.push(Date.now());
      const sock = original(url);
      if (blocked) {
        sock.readyState = 3; // never opens
        setTimeout(() => sock.onclose?.({}), 1);
      }
      return sock;
    };
    await a.session.start();
    await settle();
    blocked = true;
    server.dropAll();
    await settle(20_000);
    const gaps = attempts.slice(1).map((t, i) => t - attempts[i]!);
    // base 100 ms, doubling, capped at 800 ms (jitter disabled in this test)
    // gaps[0] includes the time the first connection was up; the rest are pure retry delays.
    expect(gaps.slice(1, 6).map((g) => Math.round(g / 10) * 10)).toEqual([200, 400, 800, 800, 800]);
    expect(DocSession.backoffFor(10, { backoffBaseMs: 500, backoffMaxMs: 15_000 })).toBe(15_000);
    expect(DocSession.backoffFor(0, { backoffBaseMs: 500, backoffMaxMs: 15_000 })).toBe(500);
  });

  it("recovers after the server drops every connection while typing", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    const b = makeClient(server, "r-b");
    await a.session.start();
    await b.session.start();
    await settle();
    await typeText(a, "one ");
    server.dropAll();
    a.session.localEdit([{ from: 4, to: 4, insert: "two " }]);
    b.session.localEdit([{ from: 0, to: 0, insert: "zero " }]);
    await settle(3000);
    expect(a.session.status).toBe("online");
    expect(a.session.text).toBe(b.session.text);
    expect(a.session.text.replace(/\s/g, "")).toContain("zero");
    expect(a.session.text).toContain("two");
    expect(a.session.outboxSize).toBe(0);
  });

  it("resends unacknowledged ops after a reconnect and the server stores them once", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    await a.session.start();
    await settle();
    // Swallow acks so the batch looks lost.
    for (const s of server.sockets) {
      const push = s.push.bind(s);
      s.push = (m) => {
        if (m["type"] !== "ack") push(m);
      };
    }
    a.session.localEdit([{ from: 0, to: 0, insert: "abc" }]);
    await settle(50);
    expect(server.head).toBe(3);
    expect(a.session.outboxSize).toBe(3);
    server.dropAll();
    await settle(2000);
    expect(server.head).toBe(3); // duplicates were not stored again
    expect(a.session.outboxSize).toBe(0); // the new connection's ack arrived
  });

  it("applies a duplicated broadcast without changing the text", async () => {
    const server = new FakeServer();
    server.broadcastFilter = (_t, ops) => [ops, ops];
    const a = makeClient(server, "r-a");
    const b = makeClient(server, "r-b");
    await a.session.start();
    await b.session.start();
    await settle();
    await typeText(a, "dup");
    await settle(100);
    expect(b.session.text).toBe("dup");
  });

  it("handles out-of-order broadcasts and asks for the missing seq with sync", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    const b = makeClient(server, "r-b");
    await a.session.start();
    await b.session.start();
    await settle();
    // Deliver only the LAST op of each batch to b: the earlier ones are "lost".
    let lose = true;
    server.broadcastFilter = (_t, ops) => (lose ? [ops.slice(-1)] : [ops]);
    await typeText(a, "abcd");
    await settle(50);
    lose = false;
    expect(b.session.lastSeq).toBe(0); // watermark cannot pass the hole
    await settle(1500); // gap timer fires, sync fetches 1..3
    expect(b.session.text).toBe("abcd");
    expect(b.session.lastSeq).toBe(4);
  });

  it("restores unsent edits after a reload and delivers them later", async () => {
    const server = new FakeServer();
    const store = new MemoryStore();
    const first = makeClient(server, "r-a", { store });
    await first.session.start();
    first.session.setOfflineMode(true);
    first.session.localEdit([{ from: 0, to: 0, insert: "draft" }]);
    await settle(100);
    await first.session.stop(); // the tab closes
    expect(server.head).toBe(0);

    const second = makeClient(server, "r-a", { store }); // same replica slot reopens
    await second.session.start();
    expect(second.session.text).toBe("draft"); // visible immediately, before connecting
    await settle(500);
    expect(second.session.status).toBe("online");
    expect(server.head).toBe(5);
    expect(second.session.outboxSize).toBe(0);
    const other = makeClient(server, "r-b");
    await other.session.start();
    await settle(300);
    expect(other.session.text).toBe("draft");
  });

  it("never reuses a delete counter or clock after a reload", async () => {
    const server = new FakeServer();
    const store = new MemoryStore();
    const first = makeClient(server, "r-a", { store });
    await first.session.start();
    await settle();
    await typeText(first, "abc");
    first.session.localEdit([{ from: 0, to: 1, insert: "" }]);
    await settle(300);
    await first.session.stop();
    const second = makeClient(server, "r-a", { store });
    await second.session.start();
    await settle(300);
    second.session.localEdit([{ from: 0, to: 1, insert: "" }, { from: 0, to: 0, insert: "Z" }]);
    await settle(300);
    const ns = server.ops.map((o) => (o.payload["op_id"] as { n: number }).n);
    expect(new Set(ns).size).toBe(ns.length); // all op counters unique
    expect(second.session.text).toBe("Zc");
  });

  it("starts a new client from the latest snapshot", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a", { config: { snapshotEvery: 5 } });
    await a.session.start();
    await settle();
    await typeText(a, "snapshot me please");
    await settle(300);
    expect(server.snapshot).not.toBeNull();
    const seqAtSnapshot = server.snapshot!.up_to_seq;
    expect(seqAtSnapshot).toBeGreaterThan(0);
    await typeText(a, "!");
    await settle(100);
    const b = makeClient(server, "r-b");
    await b.session.start();
    await settle(300);
    expect(b.session.text).toBe(a.session.text);
    expect(b.session.lastSeq).toBe(server.head);
  });

  it("pages catch-up with sync when welcome says more", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    await a.session.start();
    await settle();
    await typeText(a, "x".repeat(25));
    await settle(200);
    server.pageSize = 7;
    const b = makeClient(server, "r-b");
    await b.session.start();
    await settle(500);
    expect(b.session.text).toBe("x".repeat(25));
    expect(b.session.lastSeq).toBe(25);
  });

  it("drops a connection whose pings are never answered and reconnects", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    await a.session.start();
    await settle();
    const before = server.connections;
    server.respondToPing = false;
    await settle(2500); // heartbeat 1000 + pong timeout 500
    server.respondToPing = true;
    await settle(2000);
    expect(server.connections).toBeGreaterThan(before);
    expect(a.session.status).toBe("online");
  });

  it("retries after RATE_LIMITED without losing the batch", async () => {
    const server = new FakeServer();
    const a = makeClient(server, "r-a");
    await a.session.start();
    await settle();
    server.failNextOps = "RATE_LIMITED";
    a.session.localEdit([{ from: 0, to: 0, insert: "retry" }]);
    await settle(1000);
    expect(a.errors).toContain("RATE_LIMITED");
    expect(server.head).toBe(5);
    expect(a.session.outboxSize).toBe(0);
  });

  it("stops for good on REPLICA_IN_USE", async () => {
    const server = new FakeServer();
    const first = makeClient(server, "r-a");
    await first.session.start();
    await settle();
    const dup = makeClient(server, "r-a");
    await dup.session.start();
    await settle(3000);
    expect(dup.errors).toContain("REPLICA_IN_USE");
    expect(dup.session.status).toBe("closed");
    const connections = server.connections;
    await settle(5000);
    expect(server.connections).toBe(connections); // no reconnect storm
  });

  it("shares presence as character ids and reports peers", async () => {
    const server = new FakeServer();
    const seen: string[] = [];
    const a = makeClient(server, "r-a");
    const b = makeClient(server, "r-b");
    (b.session as unknown as { hooks: { onPresence: (p: unknown) => void } }).hooks.onPresence = (
      p,
    ) => seen.push(JSON.stringify(p));
    await a.session.start();
    await b.session.start();
    await settle();
    expect(b.session.peerList.map((p) => p.replica)).toEqual(["r-a"]);
    await typeText(a, "hello");
    a.session.setCursor(3, 5);
    await settle(100);
    expect(seen).toHaveLength(1);
    const p = JSON.parse(seen[0]!) as { anchor: { c: number; r: string }; head: { c: number } };
    expect(p.anchor).toEqual({ c: 3, r: "r-a" });
    expect(b.session.indexOfCursor(p.anchor)).toBe(3); // resolves on b's replica too
  });
});

/**
 * Chaos: random typing on several sessions while the server randomly drops
 * connections, delays and duplicates broadcasts. After the faults stop, every
 * session must show the same text and the server must hold every operation.
 */
describe("chaos (client against the fake server)", () => {
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`converges under faults (seed ${seed})`, async () => {
      const rand = prng(seed);
      const server = new FakeServer();
      server.latencyMs = 3;
      server.broadcastFilter = (_t, ops) => {
        const r = rand();
        if (r < 0.1) return []; // lost broadcast: repaired by the gap check or a reconnect
        if (r < 0.25) return [ops, ops]; // duplicate
        if (r < 0.4 && ops.length > 1) return [ops.slice(ops.length / 2), ops.slice(0, ops.length / 2)];
        return [ops];
      };
      const clients = [1, 2, 3, 4].map((i) => makeClient(server, `r-${i}`));
      for (const c of clients) await c.session.start();
      await settle(200);

      for (let step = 0; step < 150; step++) {
        const c = clients[Math.floor(rand() * clients.length)]!;
        const len = c.session.text.length;
        if (rand() < 0.25 && len > 0) {
          const from = Math.floor(rand() * len);
          c.session.localEdit([{ from, to: Math.min(len, from + 1 + Math.floor(rand() * 3)), insert: "" }]);
        } else {
          const at = Math.floor(rand() * (len + 1));
          c.session.localEdit([{ from: at, to: at, insert: "abcdef"[Math.floor(rand() * 6)]! }]);
        }
        const roll = rand();
        if (roll < 0.05) server.dropAll();
        else if (roll < 0.1) clients[Math.floor(rand() * clients.length)]!.session.setOfflineMode(true);
        else if (roll < 0.2) for (const x of clients) x.session.setOfflineMode(false);
        await settle(Math.floor(rand() * 40));
      }
      // Faults stop: everyone reconnects, broadcasts become reliable.
      server.broadcastFilter = null;
      for (const c of clients) c.session.setOfflineMode(false);
      await settle(30_000);

      const texts = clients.map((c) => c.session.text);
      expect(new Set(texts).size).toBe(1);
      for (const c of clients) {
        expect(c.session.status).toBe("online");
        expect(c.session.outboxSize).toBe(0);
        expect(c.session.lastSeq).toBe(server.head);
      }
      // A brand-new client replaying the server's log sees the same text.
      const fresh = makeClient(server, "r-fresh");
      await fresh.session.start();
      await settle(1000);
      expect(fresh.session.text).toBe(texts[0]);
    });
  }
});
