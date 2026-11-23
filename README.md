# Real-Time Collaborative Editor using CRDTs

A real-time **collaborative code workspace**: a multi-file project where many people edit at once, see each other's cursors and open files, keep working offline, and always end up with identical code on every device. The merge logic is a **CRDT (RGA, Replicated Growable Array) written from scratch** in dependency-free TypeScript and benchmarked against Yjs.

![Two people editing one project: file tree, tabs, live cursors, activity feed](docs/images/workspace-dark.png)

**Author:** Nikil R, B.E. Information Science & Engineering

## Contents

1. [At a glance](#at-a-glance)
2. [Overview](#overview)
3. [Features](#features)
4. [Architecture](#architecture)
5. [Engineering decisions and what they fixed](#engineering-decisions-and-what-they-fixed)
6. [Results](#results)
7. [Testing](#testing)
8. [Tech stack](#tech-stack)
9. [Getting started](#getting-started)
10. [Repository layout](#repository-layout)
11. [Limitations](#limitations)
12. [Documentation](#documentation)

## At a glance

| | |
|---|---|
| **Automated tests** | 191 (62 CRDT, 29 sync client, 33 web, 50 server, 17 browser end-to-end) |
| **Convergence fuzzing** | 100,000 random schedules per property, 0 divergences |
| **Load test** | 10 and 50 simulated clients pass (all operations stored, identical text everywhere) |
| **Chaos test** | 20 clients, 62 dropped connections, 1,774 duplicated and 3,403 delayed messages, one server restart: 0 operations lost, 1 final text |
| **CRDT optimisation** | 30,000 random inserts: 139.1 s down to 1.6 s |
| **Versus Yjs** | own implementation is slower and larger (measured and reported, not hidden) |
| **Code** | about 7,700 lines of TypeScript and 3,900 lines of Python, 33 commits |

Every number is from a real run on one laptop (11th Gen Intel Core i3-1115G4, 7.8 GB RAM, Windows 11, 2026-11-23). Reports with exact commands are in [`docs/results/`](docs/results/).

## Overview

### The problem

Two people edit the same file. One types at the start while the other deletes a line, and a connection drops for ten seconds in between. Position-based edits ("insert `x` at index 5") break, because index 5 no longer means the same thing on both sides.

### The approach

Every character gets a permanent unique id. An edit says "insert this character after the character with id X", not "insert at position 5". The meaning of an edit never depends on what else changed, so edits can arrive in any order, twice, or after being held offline, and every device still ends up with the same text. The server only relays and stores edits. It never decides who wins.

Two people type at the same spot at the same time (Priya types `R`, Rahul types `S`, both after the `A` of `CAT`). Both replicas end up with `CASRT`: ties are broken by comparing the characters' ids, not by guessing intent. A test for exactly this case is in `packages/crdt/test/replica.remote.test.ts`.

```mermaid
flowchart LR
    A["Priya types R after A"] --> M(("Merge by<br/>character id"))
    B["Rahul types S after A"] --> M
    M --> R1["Priya sees CASRT"]
    M --> R2["Rahul sees CASRT"]
```

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| ![Landing page](docs/images/landing.png) | ![Light theme with Markdown preview](docs/images/workspace-light-preview.png) |
| ![CRDT debug panel showing character ids and tombstones](docs/images/workspace-debug.png) | |

</details>

## Features

**Editing**
- Live multi-user editing of every file through the CRDT.
- Offline editing: typing never blocks, unsent edits are saved in IndexedDB and survive a reload, and everything merges on reconnect.
- CodeMirror 6 with syntax highlighting for TypeScript, JavaScript, Python, JSON, Markdown, HTML and CSS, line numbers, bracket matching, autocomplete, search, folding and a dark and light theme.

**Workspace**
- Multi-file project: file explorer with folders, tabs, quick open (`Ctrl P`), and create, rename and delete that everyone sees instantly.
- Presence: names, colours, remote cursors and selections (stored as character ids so they stay on the right character while others type) and a People list showing which file each person has open.
- Activity feed: who created, renamed and edited which file (edits are merged per person and file by the Python server).
- Sanitised Markdown preview, because another collaborator controls the text.

**Reliability and operations**
- Gap-free server sequence numbers and a contiguous client watermark, so a missed broadcast is always detected and repaired.
- Client-uploaded snapshots and a compaction job for long documents.
- Redis fan-out so several server processes can serve one document.
- Debug panel showing character ids, tombstones, clock, pending operations and the outbox.
- Prometheus metrics and a provisioned Grafana dashboard.

## Architecture

### System overview

Clients own the merge logic. The server owns delivery and storage. That is why offline editing works: an offline client is just one whose operations are delivered late.

```mermaid
flowchart TB
    subgraph A["Browser A"]
        EA["CodeMirror 6<br/>editor binding"] --> SA["DocSession<br/>RGA replica + outbox"]
        SA --- IA[("IndexedDB<br/>unsent ops")]
    end
    subgraph B["Browser B"]
        EB["CodeMirror 6<br/>editor binding"] --> SB["DocSession<br/>RGA replica + outbox"]
        SB --- IB[("IndexedDB<br/>unsent ops")]
    end
    SA <-- "WebSocket (JSON)" --> API
    SB <-- "WebSocket (JSON)" --> API
    subgraph S["FastAPI server (1..N processes)"]
        API["Validate shape, de-duplicate,<br/>assign seq, ack, broadcast.<br/>Never interprets an operation."]
    end
    API --> PG[("PostgreSQL or SQLite<br/>append-only op log + snapshots")]
    API <--> RD{{"Redis pub/sub<br/>fan-out between processes"}}
    API --> PM["Prometheus metrics"] --> GF["Grafana"]
```

### Life of one keystroke

```mermaid
sequenceDiagram
    participant U as User A
    participant A as Client A (replica + outbox)
    participant S as Server
    participant D as Database
    participant B as Client B
    U->>A: types "x"
    A->>A: apply locally (instant), save to outbox
    A->>S: op {id, origin, char}
    S->>D: append, assign seq (gap-free)
    S-->>A: ack {seq}
    S-->>B: broadcast op with seq
    B->>B: integrate by id, update editor
    Note over A,B: If A is offline, the op waits in the outbox<br/>and is sent on reconnect. The result is the same.
```

### Recovering from a lost message

```mermaid
stateDiagram-v2
    [*] --> Live
    Live --> Gap: broadcast seq 7 arrives, watermark is 5
    Gap --> Syncing: send sync with last_seq 5
    Syncing --> Live: receive 6 and 7, watermark = 7
    Live --> Offline: connection drops
    Offline --> Syncing: reconnect, resend outbox, request missed ops
```

### Data model

```mermaid
erDiagram
    PROJECT ||--o{ DOCUMENT : "has files"
    PROJECT ||--o{ ACTIVITY : "has feed"
    DOCUMENT ||--o{ OPERATION : "append-only log"
    DOCUMENT ||--o{ SNAPSHOT : "compaction points"
    PROJECT {
        uuid id PK
        text name
    }
    DOCUMENT {
        uuid id PK
        text name "path such as src/app.ts"
        bigint last_seq
        timestamp deleted_at
    }
    OPERATION {
        uuid doc_id PK
        bigint seq PK "gap-free per document"
        text op_replica "unique with op_counter"
        bigint op_counter
        json payload "opaque to the server"
    }
    SNAPSHOT {
        uuid doc_id PK
        bigint up_to_seq PK
        json state
    }
    ACTIVITY {
        bigint id PK
        text actor
        text kind
        int count
    }
```

More detail: [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md), the algorithm: [`docs/03-CRDT-DESIGN.md`](docs/03-CRDT-DESIGN.md), the wire format: [`docs/04-PROTOCOL.md`](docs/04-PROTOCOL.md), the schema: [`docs/05-DATABASE.md`](docs/05-DATABASE.md).

## Engineering decisions and what they fixed

Problems found by the tests and load runs, and what changed. Numbers are from the reports in [`docs/results/`](docs/results/).

| Problem | Evidence | Fix |
|---|---|---|
| Server could not keep up with 50 clients | 50 clients generated 7,251 operations, the server had stored 1,315 when the 120 s settle window ended; median latency 13.4 s | Group commit per document, one write lock per process, and each broadcast encoded once. All three 50-client runs now pass, median latency 1.9 to 4.7 s |
| Random inserts were quadratic | 30,000 random single-character inserts took 139.1 s | Nodes indexed by reference with a self-validating position hint: 1.6 s. The first version of the index made 100k pastes 7x slower, which the hint fixed |
| Out-of-order broadcasts | Found by the sync client chaos tests | Gap-free per-document sequence numbers and a contiguous client watermark; a gap triggers a `sync` request |
| A sender never learned its own operations were stored | Found by tests | `ack.seqs` in the acknowledgement |
| A lost last broadcast could go unnoticed | Found by tests | The `pong` carries the server's head sequence, so a quiet client notices it is behind |
| Two tabs sharing one replica id corrupt a document | Found by e2e tests | One replica id per live editor, claimed with a Web Lock on (document, slot); the server rejects duplicates with `REPLICA_IN_USE` |
| Starter files created twice when two people open a new workspace | e2e tests | `claim-seed`: the server lets exactly one client type the starter text |
| Markdown preview kept `<form>` and `<input>` | Unit test | DOMPurify configured to forbid those tags and attributes |
| Redis 5.0 rejected the newer protocol handshake | Integration run on real Redis | Client pinned to `protocol=2` |

<!-- RESULTS:START -->

## Results

All numbers below were produced on 2026-11-23 on one machine (11th Gen Intel Core i3-1115G4, 7.8 GB RAM, Windows 11, Node 24) with clients and server on the same machine and the server on a **SQLite file, not PostgreSQL**. Each line links to a report in [`docs/results/`](docs/results/) that records the exact command. Treat them as demo-scale, relative numbers.

**Convergence (property-based fuzzing, 0 divergences).** 2 to 6 replicas, random edits, delivery order, delays and duplicates; after delivery every replica must show identical text, equal to the surviving characters. Details and the sanity check that the tests can fail: [`crdt-convergence`](docs/results/2026-11-23-crdt-convergence.md).

**Load test: random typing (5 characters per second per client, 30 s) into one document**

| Clients | Runs | Verdict | Ops generated | Stored ops/s | p50 ms | p95 ms | p99 ms | DB write ms (avg per batch) |
|---|---|---|---|---|---|---|---|---|
| 10 | 3 | all passed | 1,428 to 1,431 | 47.6 to 47.7 | 46 to 51 | 67 to 73 | 90 to 105 | 11.4 to 13.6 |
| 50 | 3 | all passed | 7,355 to 7,497 | 245.2 to 249.9 | 1,903 to 4,681 | 8,201 to 12,456 | 8,323 to 14,065 | 21.4 to 28.9 |
| 100 | 3 | none passed; the server had stored 78% to 89% of the operations when the 120 s settle window ended | 14,577 to 14,833 | 379.8 to 441.5 | 8,555 to 8,706 | 20,878 to 21,186 | 22,552 to 22,960 | 111.8 to 183.2 |

A run **passes** only if, after typing stops and faults end, every replica holds identical text, the server stored every operation that was generated, and a fresh client replaying the log gets the same text. A run that fails because the server is still working through a backlog is **saturation, not divergence**: the single-process server on a SQLite file, with all simulated clients on the same 4-thread laptop, could not keep up with the offered load. No claim is made that 100 clients converge.

Latency is measured from the moment a client creates an operation to the moment another client's session receives it from the server (same process clock), so it includes the client's 30 ms batching window and the database write.

**Chaos run** (20 clients, 30 s of typing with random disconnects, 1 to 10 s offline periods, delayed, duplicated and reordered messages, and one server restart mid-run):

- verdict: passed; operations generated 2913, stored by the server 2913 (missing: 0)
- distinct final texts across all replicas: 1; a fresh client replaying the log matches: True
- faults injected: 62 dropped connections, 3403 delayed and 1774 duplicated messages; server restarted: True; time to settle after faults stopped: 1.6 s
- latency during chaos is dominated by offline periods (p50 613 ms, p99 16,135 ms) and is not a performance figure

**Own CRDT versus Yjs** (same seeded synthetic trace, one run, results checked against a plain-string model; [details](docs/results/2026-11-23-yjs-comparison.md)):

| Edits in the trace | 10,000 | 50,000 |
|---|---|---|
| Local apply, own / Yjs (ms) | 200 / 225 | 7,075 / 949 |
| Replay on a fresh replica, own / Yjs incremental (ms) | 333 / 107 | 9,751 / 439 |
| Size: own operations as JSON / Yjs merged update (bytes) | 1,885,112 / 76,828 | 9,661,410 / 415,296 |

Own implementation is slower and larger than Yjs, as expected for a first version; the gap widens with document size.

**CRDT optimisation:** 30,000 random single-character inserts took 139.1 s before and 1.6 s after indexing nodes by reference (idle-machine run, one run each). Deletes and in-order remote apply did not improve. Run-to-run noise on this laptop was large, see [`crdt-optimisation`](docs/results/2026-11-23-crdt-optimisation.md).

<!-- RESULTS:END -->

## Testing

| What | Tests | Command |
|---|---|---|
| CRDT unit and property tests (fast-check) | 62 | `pnpm test:crdt` (`pnpm test:crdt:full` for 10,000 schedules per property) |
| Sync client, against an in-memory fake server, with seeded chaos runs | 29 | `pnpm test:client` |
| Web unit tests (store, channel, binding, IndexedDB, Markdown sanitising) | 33 | `pnpm test:web` |
| Server (SQLite and fake Redis) | 50 | `cd server; uv run pytest` |
| Server against real PostgreSQL and Redis | 50 | set `TEST_DATABASE_URL` (for example `postgresql+asyncpg://user:pw@localhost:5432/collab_editor_test`) and `TEST_REDIS_URL`, then `uv run pytest` |
| End-to-end, real browsers (Edge by default, `PW_CHANNEL=chromium` elsewhere) | 17 | `pnpm e2e` |
| Load test (10, 50, 100 clients) and chaos run | n/a | `pnpm loadtest -- --clients 50 --duration 30 --spawn-server` (`--chaos` adds faults) |
| Regenerate the README screenshots | n/a | `SCREENSHOTS=1 pnpm --filter @rce/web exec playwright test -g screenshots` |

The convergence properties checked on random schedules: identical text and identical internal structure on all replicas, order independence, idempotence, intention preserved, deletions respected, no lost or duplicated characters, and serialisation round trips. CI runs the suites and builds the Docker images on every push ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Tech stack

| Layer | Choice |
|---|---|
| CRDT core | TypeScript (strict), no runtime dependencies; Vitest and fast-check |
| Web app | Next.js (App Router), React, TypeScript, Tailwind CSS (design tokens, dark and light), shadcn-style components, Zustand, CodeMirror 6 with language packs, Dexie (IndexedDB), marked and DOMPurify |
| Server | Python, FastAPI and WebSockets, Pydantic v2, SQLAlchemy 2 (async), Alembic, structlog, uv, Ruff |
| Storage | PostgreSQL (append-only operation log and snapshots); SQLite for local development |
| Scale-out | Redis pub/sub |
| Tests | Vitest, fast-check, pytest, Playwright, custom load and chaos runner |
| Observability | Prometheus and Grafana |
| Deploy | Docker Compose, Caddy (HTTPS), GitHub Actions |

## Getting started

Requirements: Node 20+ with pnpm, Python 3.11+ with [uv](https://docs.astral.sh/uv/).

```powershell
pnpm install
cd server; uv sync; uv run uvicorn app.main:app --reload     # API on http://localhost:8000 (SQLite file)
pnpm dev:web                                                  # app on http://localhost:3000 (second terminal, repo root)
```

Open http://localhost:3000, click **Create a workspace**, and open the link in a second window. Open different files in each window and watch the People list and cursors. Use **Simulate offline** in the status bar to try the offline flow, and **Debug** to see the CRDT characters and tombstones.

With Docker: `docker compose up --build` starts PostgreSQL, Redis, the server, the web app, Prometheus (9090) and Grafana (3001); `--profile scale` adds a second server process.

## Repository layout

```
packages/crdt/      the RGA CRDT (TypeScript, no runtime dependencies) + tests + benchmarks
packages/client/    sync session: outbox, reconnect, watermark, presence (framework agnostic)
apps/web/           Next.js app (CodeMirror 6, Zustand, Tailwind, Dexie) + Playwright tests
server/             FastAPI relay, SQLAlchemy models, Alembic migrations, compaction job, tests
loadtest/           load and chaos runner with fault injection
ops/                Prometheus, Grafana dashboard, Caddyfile
docs/               design, protocol, database, testing, deployment, results, learning journal
```

## Limitations

- **Performance is a first version.** One node per character in an array: editing is O(n) per operation, a 50,000-edit trace is about 7x slower to apply and 22x slower to replay than Yjs, and the JSON wire format is about 23x larger than Yjs's merged update. Run-length encoding, a tree index and a binary format are the known fixes and are not done.
- **Plain text only.** No rich text, no accounts or permissions (workspaces are shared by an unguessable link), no end-to-end encryption, no code execution.
- **Starter text counts as an edit** in the activity feed: the server cannot build CRDT operations, so one client types the starter files in.
- **Project presence is per server process plus Redis**: if a server process crashes, its people stay in the list until their clients reconnect.
- **Tombstones are never garbage collected**; memory and state size grow with deletes.
- **Interleaving:** concurrent typing of whole words at one spot can interleave characters, a known weakness of simple sequence CRDTs.
- **Measured on SQLite on one laptop**, with clients and server on the same machine. These are demo-scale numbers, not production numbers.
- **The 100-client load scenario does not pass**: one Python process on a SQLite file, sharing a 4-thread laptop with 100 simulated clients, falls behind.
- **Docker images are built by CI only**; they have not been run on the development machine. There is no demo GIF and no public deployment yet.

## Documentation

[`01-PRD`](docs/01-PRD.md) goals and targets, [`02-ARCHITECTURE`](docs/02-ARCHITECTURE.md), [`03-CRDT-DESIGN`](docs/03-CRDT-DESIGN.md), [`04-PROTOCOL`](docs/04-PROTOCOL.md), [`05-DATABASE`](docs/05-DATABASE.md), [`06-ROADMAP`](docs/06-ROADMAP.md) (status of every deliverable), [`07-TESTING`](docs/07-TESTING.md), [`08-DEPLOYMENT`](docs/08-DEPLOYMENT.md), [`09-DEMO`](docs/09-DEMO.md), [`10-GLOSSARY`](docs/10-GLOSSARY.md), [`learning-journal`](docs/learning-journal.md), and the dated measurements in [`docs/results/`](docs/results/).
