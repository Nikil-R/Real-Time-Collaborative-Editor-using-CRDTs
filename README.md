# Real-Time Collaborative Editor using CRDTs

A real-time collaborative text editor where many people type in the same document at once, work offline, and always end up with identical text on every device. The merge logic is a **CRDT (RGA, Replicated Growable Array) written from scratch** in dependency-free TypeScript, then compared against Yjs.

**Author:** Nikil R

> **Status (2026-11-23):** implemented and tested on a development machine. The CRDT, sync client, FastAPI server, Next.js app, load and chaos tests and the Yjs comparison are done and measured. Not done or not verified: the PostgreSQL and Redis variants of the server tests and the Docker/CI files were written but **not run** (neither was available on the development machine); there is no demo GIF and no live deployment yet. See [Limitations](#honest-limitations).

## The one-paragraph explanation

Every character gets a permanent unique ID. An edit says "insert this character after the character with ID X", not "insert at position 5". Because the meaning of an edit never depends on what else changed, edits can arrive in any order, twice, or after being held offline, and every device still ends up with the same text. The server only relays and stores edits. It never decides who wins.

Two people type at the same spot at the same time (Priya types `R`, Rahul types `S`, both after the `A` of `CAT`). Both replicas end up with `CASRT`: ties are broken by comparing the characters' ids, not by guessing intent. A test for exactly this case is in `packages/crdt/test/replica.remote.test.ts`.

## Architecture

```
  Browser A                                           Browser B
 +----------------------+                          +----------------------+
 | CodeMirror 6         |                          | CodeMirror 6         |
 | editor binding       |                          | editor binding       |
 | DocSession (sync)    |                          | DocSession (sync)    |
 |  - RGA CRDT replica  |                          |  - RGA CRDT replica  |
 |  - outbox (IndexedDB)|                          |  - outbox (IndexedDB)|
 +----------+-----------+                          +-----------+----------+
            | WebSocket (JSON)                                 | WebSocket
            v                                                  v
        +---------------------------------------------------------+
        |  FastAPI server (1..N processes)                         |
        |  validates shape, de-duplicates, stores, assigns seq,    |
        |  acks, broadcasts. Never interprets an operation.        |
        +-----------+-------------------------+-------------------+
                    v                         v
             PostgreSQL / SQLite        Redis pub/sub
        (append-only op log, snapshots)  (fan-out between processes)
```

Clients own the merge logic; the server owns delivery and storage. That is why offline editing works: an offline client is just one whose operations are delivered late. Details: [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md), the algorithm: [`docs/03-CRDT-DESIGN.md`](docs/03-CRDT-DESIGN.md), the wire format: [`docs/04-PROTOCOL.md`](docs/04-PROTOCOL.md).

## Features

- Live multi-user editing with names, colours and remote cursors/selections (stored as character ids, so they stay on the right character while others type).
- Offline editing: typing never blocks; unsent edits are saved in IndexedDB and survive a reload; everything merges on reconnect.
- Gap-free server sequence numbers and a contiguous client watermark, so a missed broadcast is always detected and repaired.
- Client-uploaded snapshots and a compaction job for long documents.
- Redis fan-out so several server processes can serve one document.
- Debug panel that shows character ids, tombstones, clock, pending operations and the outbox.
- Prometheus metrics and a provisioned Grafana dashboard.

## Quick start (no Docker needed)

Requirements: Node 20+ with pnpm, Python 3.11+ with [uv](https://docs.astral.sh/uv/).

```powershell
pnpm install
cd server; uv sync; uv run uvicorn app.main:app --reload     # API on http://localhost:8000 (SQLite file)
pnpm dev:web                                                  # app on http://localhost:3000 (second terminal, repo root)
```

Open http://localhost:3000, create a document, and open the link in a second window. Use **Simulate offline** in the header to try the offline flow.

With Docker (written, not yet run on the development machine): `docker compose up --build` starts PostgreSQL, Redis, the server, the web app, Prometheus (9090) and Grafana (3001); `--profile scale` adds a second server process.

## Tests

| What | Command |
|---|---|
| CRDT unit and property tests | `pnpm test:crdt` (`pnpm test:crdt:full` for 10,000 schedules per property) |
| Sync client (against an in-memory fake server, with chaos runs) | `pnpm test:client` |
| Web unit tests | `pnpm test:web` |
| Server (SQLite and fake Redis) | `cd server; uv run pytest` |
| Server against real PostgreSQL and Redis | set `TEST_DATABASE_URL` and `TEST_REDIS_URL`, then `uv run pytest` |
| End-to-end, real browsers (Edge by default, `PW_CHANNEL=chromium` elsewhere) | `pnpm e2e` |
| Load test (10, 50, 100 clients), chaos run | `pnpm loadtest -- --clients 50 --duration 30 --spawn-server` (`--chaos` adds faults) |

<!-- RESULTS:START -->
<!-- RESULTS:END -->

## Repository layout

```
packages/crdt/      the RGA CRDT (TypeScript, no runtime dependencies) + tests + benchmarks
packages/client/    sync session: outbox, reconnect, watermark, presence (framework agnostic)
apps/web/           Next.js app (CodeMirror 6, Zustand, Tailwind, Dexie) + Playwright tests
server/             FastAPI relay, SQLAlchemy models, Alembic migration, compaction job, tests
loadtest/           load and chaos runner with fault injection
ops/                Prometheus, Grafana dashboard, Caddyfile
docs/               design, protocol, database, testing, deployment, results, learning journal
```

## Tech stack

| Layer | Choice |
|---|---|
| CRDT core | TypeScript (strict), no runtime dependencies; Vitest + fast-check |
| Web app | Next.js (App Router) + React + TypeScript, Tailwind CSS, shadcn-style components, Zustand, CodeMirror 6, Dexie (IndexedDB) |
| Server | Python, FastAPI + WebSockets, Pydantic v2, SQLAlchemy 2 (async), Alembic, structlog, uv, Ruff |
| Storage | PostgreSQL (append-only operation log + snapshots); SQLite for local development |
| Scale-out | Redis pub/sub |
| Tests | Vitest, fast-check, pytest, Playwright, custom load and chaos runner |
| Observability | Prometheus + Grafana |
| Deploy | Docker Compose, Caddy (HTTPS), GitHub Actions |

## Honest limitations

- **Performance is a first version.** One node per character in an array: editing is O(n) per operation, a 50,000-edit trace is about 7x slower to apply and 22x slower to replay than Yjs, and the JSON wire format is about 23x larger than Yjs's merged update (see the Yjs comparison in `docs/results/`). Run-length encoding, a tree index and a binary format are the known fixes and are not done.
- **Plain text only.** No rich text, no accounts or permissions (documents are shared by an unguessable link), no end-to-end encryption.
- **Tombstones are never garbage collected**; memory and state size grow with deletes.
- **Interleaving:** concurrent typing of whole words at one spot can interleave characters (a known weakness of simple sequence CRDTs).
- **Measured on SQLite on one laptop**, with clients and server on the same machine. The results below say what that means; they are not production numbers.
- **Not run here:** real PostgreSQL and Redis, Docker, the GitHub Actions workflow.
- No demo GIF and no live deployment yet. "Demo-scale, tested with simulated clients" is the accurate description, not "production-ready".

## Documentation

[`docs/01-PRD.md`](docs/01-PRD.md) goals and targets, [`02-ARCHITECTURE`](docs/02-ARCHITECTURE.md), [`03-CRDT-DESIGN`](docs/03-CRDT-DESIGN.md), [`04-PROTOCOL`](docs/04-PROTOCOL.md), [`05-DATABASE`](docs/05-DATABASE.md), [`06-ROADMAP`](docs/06-ROADMAP.md) (status of every deliverable), [`07-TESTING`](docs/07-TESTING.md), [`08-DEPLOYMENT`](docs/08-DEPLOYMENT.md), [`09-DEMO-AND-RESUME`](docs/09-DEMO-AND-RESUME.md), [`10-GLOSSARY`](docs/10-GLOSSARY.md), [`learning-journal`](docs/learning-journal.md), and the dated measurements in [`docs/results/`](docs/results/).
