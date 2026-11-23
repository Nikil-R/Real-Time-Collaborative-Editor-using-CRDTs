/**
 * Load and chaos test (docs/07-TESTING.md sections 6 and 7).
 *
 * N simulated clients, each a real DocSession with its own CRDT replica,
 * type random edits into one document through the real server. Afterwards the
 * script checks that every replica holds identical text and that the server
 * stored every operation, then prints (and optionally writes) a report.
 *
 *   pnpm --filter @rce/loadtest start -- --clients 50 --duration 30 --spawn-server
 *   pnpm --filter @rce/loadtest start -- --clients 20 --chaos --spawn-server --out results.md
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocSession, MemoryStore, type SocketLike } from "@rce/client";
import { faultySocketFactory, type FaultCounters, type FaultSwitch } from "./faults";
import { summarize } from "./stats";

interface Args {
  url: string;
  clients: number;
  duration: number;
  rate: number;
  chaos: boolean;
  spawnServer: boolean;
  out: string | null;
  seed: number;
  port: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    url: "http://127.0.0.1:8000",
    clients: 10,
    duration: 30,
    rate: 5,
    chaos: false,
    spawnServer: false,
    out: null,
    seed: 1,
    port: 8200,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--") continue;
    if (k === "--url" && v) (a.url = v), i++;
    else if (k === "--clients" && v) (a.clients = Number(v)), i++;
    else if (k === "--duration" && v) (a.duration = Number(v)), i++;
    else if (k === "--rate" && v) (a.rate = Number(v)), i++;
    else if (k === "--seed" && v) (a.seed = Number(v)), i++;
    else if (k === "--port" && v) (a.port = Number(v)), i++;
    else if (k === "--out" && v) (a.out = v), i++;
    else if (k === "--chaos") a.chaos = true;
    else if (k === "--spawn-server") a.spawnServer = true;
    else throw new Error(`unknown argument ${String(k)}`);
  }
  return a;
}

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------ server control

interface Spawned {
  child: ChildProcess;
  base: string;
  dbFile: string;
}

function startServer(port: number, dbFile: string): Spawned {
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");
  const child = spawn(
    "uv",
    ["run", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        DATABASE_URL: `sqlite+aiosqlite:///${dbFile.replace(/\\/g, "/")}`,
        ALLOWED_ORIGINS: "*",
        LOG_LEVEL: "warning",
        RATE_LIMIT_OPS_PER_SEC: "1000",
      },
      stdio: "ignore",
    },
  );
  return { child, base: `http://127.0.0.1:${port}`, dbFile };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

async function waitHealthy(base: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`server at ${base} did not become healthy`);
}

async function scrape(base: string): Promise<{ dbWriteMsAvg: number | null; batches: number | null }> {
  try {
    const text = await (await fetch(`${base}/metrics`)).text();
    const num = (name: string) => {
      const m = new RegExp(`^${name}\\s+([0-9.e+-]+)`, "m").exec(text);
      return m ? Number(m[1]) : null;
    };
    const sum = num("collab_db_write_seconds_sum");
    const count = num("collab_db_write_seconds_count");
    return {
      dbWriteMsAvg: sum !== null && count ? (sum / count) * 1000 : null,
      batches: num("collab_batches_total"),
    };
  } catch {
    return { dbWriteMsAvg: null, batches: null };
  }
}

// ------------------------------------------------------------------- the run

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rand = prng(args.seed);
  const startedAt = new Date();

  let server: Spawned | null = null;
  let base = args.url.replace(/\/$/, "");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "rce-load-"));
  const dbFile = path.join(tmp, "load.db");
  if (args.spawnServer) {
    server = startServer(args.port, dbFile);
    base = server.base;
  }
  try {
    await waitHealthy(base);
    const doc = (await (await fetch(`${base}/api/documents`, { method: "POST" })).json()) as {
      id: string;
    };
    const wsBase = base.replace(/^http/, "ws");

    const faultSwitch: FaultSwitch = { active: args.chaos };
    const counters: FaultCounters = { dropped: 0, delayed: 0, duplicated: 0 };
    const baseFactory = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;
    const factory = args.chaos
      ? faultySocketFactory(
          baseFactory,
          { dropProb: 0.002, delayProb: 0.1, maxDelayMs: 2000, dupProb: 0.05 },
          faultSwitch,
          counters,
          rand,
        )
      : baseFactory;

    const created = new Map<string, number>();
    const latencies: number[] = [];
    let opsGenerated = 0;

    const sessions: DocSession[] = [];
    for (let i = 0; i < args.clients; i++) {
      const replicaId = `lt-${i}`;
      sessions.push(
        new DocSession({
          docId: doc.id,
          replicaId,
          name: replicaId,
          color: "#888888",
          wsUrl: `${wsBase}/ws/${doc.id}`,
          store: new MemoryStore(),
          socketFactory: factory,
          // The load test uploads no snapshots, so the log is replayed in full.
          config: { random: rand, snapshotEvery: Number.MAX_SAFE_INTEGER },
          hooks: {
            onLocalOps(ops) {
              const now = performance.now();
              opsGenerated += ops.length;
              for (const o of ops) created.set(`${o.op_id.r}#${o.op_id.n}`, now);
            },
            onServerOps(ops) {
              const now = performance.now();
              for (const o of ops) {
                const t = created.get(`${o.op_id.r}#${o.op_id.n}`);
                if (t !== undefined) latencies.push(now - t);
              }
            },
          },
        }),
      );
    }
    await Promise.all(sessions.map((s) => s.start()));
    const deadline = Date.now() + 60_000;
    while (sessions.some((s) => s.status !== "online") && Date.now() < deadline) await sleep(100);
    if (sessions.some((s) => s.status !== "online")) throw new Error("clients failed to connect");
    console.log(`${args.clients} clients online on document ${doc.id}`);

    // ---- typing ----------------------------------------------------------
    const alphabet = "abcdefghijklmnopqrstuvwxyz ";
    const tickMs = 1000 / args.rate;
    const t0 = performance.now();
    const timers = sessions.map((s) =>
      setInterval(() => {
        if (s.status === "closed") return;
        const len = s.text.length;
        if (len > 0 && rand() < 0.2) {
          const from = Math.floor(rand() * len);
          s.localEdit([{ from, to: from + 1, insert: "" }]);
        } else {
          const at = Math.floor(rand() * (len + 1));
          s.localEdit([{ from: at, to: at, insert: alphabet[Math.floor(rand() * alphabet.length)]! }]);
        }
      }, tickMs * (0.9 + rand() * 0.2)),
    );

    let restarted = false;
    const chaosTimer = args.chaos
      ? setInterval(() => {
          const s = sessions[Math.floor(rand() * sessions.length)]!;
          if (rand() < 0.5) {
            s.setOfflineMode(true);
            setTimeout(() => s.setOfflineMode(false), 1000 + rand() * 9000);
          }
        }, 1500)
      : null;
    const restartTimer =
      args.chaos && server
        ? setTimeout(() => {
            console.log("restarting the server mid-run");
            killTree(server!.child);
            setTimeout(() => {
              server = startServer(args.port, dbFile);
              restarted = true;
            }, 1500);
          }, (args.duration * 1000) / 2)
        : null;

    await sleep(args.duration * 1000);
    const typingSeconds = (performance.now() - t0) / 1000;
    timers.forEach(clearInterval);
    if (chaosTimer) clearInterval(chaosTimer);
    if (restartTimer) clearTimeout(restartTimer);

    // ---- stop faults and wait for everyone to catch up ----------------------
    faultSwitch.active = false;
    for (const s of sessions) s.setOfflineMode(false);
    if (args.chaos && server && !restarted) await sleep(2500);
    await waitHealthy(base);
    const syncStart = performance.now();
    let head = 0;
    const settleDeadline = Date.now() + 120_000;
    while (Date.now() < settleDeadline) {
      head = ((await (await fetch(`${base}/api/documents/${doc.id}`)).json()) as { last_seq: number })
        .last_seq;
      const done = sessions.every(
        (s) => s.status === "online" && s.outboxSize === 0 && s.lastSeq === head,
      );
      if (done) break;
      await sleep(250);
    }
    const settleSeconds = (performance.now() - syncStart) / 1000;

    // ---- verdict -------------------------------------------------------------
    const texts = sessions.map((s) => s.text);
    const distinct = new Set(texts).size;
    const allCaughtUp = sessions.every((s) => s.outboxSize === 0 && s.lastSeq === head);
    const missingOps = opsGenerated - head;
    const replay = new DocSession({
      docId: doc.id,
      replicaId: "lt-replay",
      name: "replay",
      color: "#000000",
      wsUrl: `${wsBase}/ws/${doc.id}`,
      store: new MemoryStore(),
      socketFactory: baseFactory,
      config: { snapshotEvery: Number.MAX_SAFE_INTEGER },
    });
    await replay.start();
    const replayDeadline = Date.now() + 60_000;
    while (replay.lastSeq < head && Date.now() < replayDeadline) await sleep(100);
    const replayMatches = replay.text === texts[0];
    await replay.stop();

    const metrics = await scrape(base);
    const first = sessions[0]!;
    const nodeCount = first.doc.nodeCount;
    const lat = summarize(latencies);
    const passed = distinct === 1 && allCaughtUp && missingOps === 0 && replayMatches;

    const report = {
      passed,
      clients: args.clients,
      chaos: args.chaos,
      typingSeconds: Number(typingSeconds.toFixed(1)),
      opsGenerated,
      opsStoredByServer: head,
      missingOps,
      distinctTexts: distinct,
      replayMatches,
      settleSeconds: Number(settleSeconds.toFixed(1)),
      throughputOpsPerSec: Number((head / typingSeconds).toFixed(1)),
      finalVisibleChars: first.text.length,
      finalNodes: nodeCount,
      tombstoneOverhead: Number((nodeCount / Math.max(1, first.text.length)).toFixed(2)),
      latencyMs: {
        count: lat.count,
        p50: Number(lat.p50.toFixed(1)),
        p95: Number(lat.p95.toFixed(1)),
        p99: Number(lat.p99.toFixed(1)),
        max: Number(lat.max.toFixed(1)),
      },
      serverDbWriteMsAvg: metrics.dbWriteMsAvg === null ? null : Number(metrics.dbWriteMsAvg.toFixed(2)),
      faults: counters,
      serverRestarted: restarted,
    };
    console.log(JSON.stringify(report, null, 2));

    if (args.out) {
      const md = [
        `# ${args.chaos ? "Chaos" : "Load"} run: ${args.clients} clients`,
        "",
        `Date: ${startedAt.toISOString()}`,
        `Machine: ${os.cpus()[0]?.model ?? "unknown CPU"} (${os.cpus().length} threads), ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, ${os.platform()} ${os.release()}`,
        `Node ${process.version}; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine`,
        `Command: \`${["pnpm --filter @rce/loadtest start --", ...process.argv.slice(2)].join(" ")}\``,
        "",
        "```json",
        JSON.stringify(report, null, 2),
        "```",
        "",
      ].join("\n");
      writeFileSync(args.out, md);
    }
    for (const s of sessions) await s.stop();
    process.exitCode = passed ? 0 : 1;
  } finally {
    if (server) killTree(server.child);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
