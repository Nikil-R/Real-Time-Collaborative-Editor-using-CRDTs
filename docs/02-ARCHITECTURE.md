# 02 - Architecture

## 1. Big picture

```
  Browser A                                           Browser B
 +------------------+                              +------------------+
 | CodeMirror 6     |                              | CodeMirror 6     |
 |   |  ^           |                              |   |  ^           |
 |   v  |           |                              |   v  |           |
 | Editor binding   |                              | Editor binding   |
 |   |  ^           |                              |   |  ^           |
 |   v  |           |                              |   v  |           |
 | CRDT (RGA)       |                              | CRDT (RGA)       |
 | Outbox (IndexedDB)|                             | Outbox (IndexedDB)|
 +--------+---------+                              +---------+--------+
          | WebSocket                                        | WebSocket
          v                                                  v
        +---------------------------------------------------------+
        |  FastAPI server (1..N processes)                         |
        |  - validates and deduplicates operations                 |
        |  - appends to Postgres, assigns a per-document seq      |
        |  - broadcasts to other clients of that document          |
        +-----------+-------------------------+-------------------+
                    |                         |
                    v                         v
             PostgreSQL                 Redis pub/sub
       (operation log, snapshots)   (fan-out between processes)
```

## 2. Core principle
**Clients own the merge logic. The server owns delivery and storage.**
- Every client runs the same CRDT code, so every client reaches the same text by itself.
- The server never decides whose edit wins. It relays opaque operations, stores them, and replays them to anyone who missed them.
- This is why offline editing works: an offline client is just a client whose operations are delivered late.

## 3. Components

### 3.1 `packages/crdt` (TypeScript library)
- Pure logic. No DOM, no network, no timers.
- Exposes: `createReplica(replicaId)`, `localInsert(index, text)`, `localDelete(index, length)`, `applyRemote(op)`, `getText()`, `getState()`, `loadState()`.
- Details in `03-CRDT-DESIGN.md`.

### 3.2 `apps/web` (Next.js + React + TypeScript + CodeMirror 6)
Next.js is used as the frontend framework only. All editor, sync and offline code lives in client components (`"use client"`, with the editor loaded via `dynamic(..., { ssr: false })`). There are no Next.js API routes: the backend is FastAPI.
- **Editor binding:** converts CodeMirror transactions into CRDT local operations, and CRDT remote changes into CodeMirror transactions.
- **Sync client:** WebSocket connection, reconnect with backoff, resync from the last seen sequence number.
- **Outbox:** operations created locally are stored in IndexedDB until the server acknowledges them.
- **Presence:** cursor and selection stored as character IDs (not indexes) so they stay correct when the text changes.
- **Debug panel:** shows the character list, tombstones, pending ops, vector clock.

### 3.3 `server` (FastAPI)
- WebSocket endpoint `/ws/{doc_id}`.
- Validates message shape and size, never CRDT semantics.
- Deduplicates by `(replica_id, counter)`.
- Appends to the operation log, assigns increasing `seq` per document.
- Broadcasts to other clients in the same document, locally and via Redis.
- REST endpoints: create document, fetch snapshot, health, metrics.

### 3.4 PostgreSQL
- `operations` (append-only log), `snapshots`, `documents`. See `05-DATABASE.md`.

### 3.5 Redis
- One pub/sub channel per document. Used only when several server processes run.

### 3.6 `loadtest`
- Node script that opens many WebSocket clients, each running its own CRDT replica, typing random edits, then checking that all replicas converge. Reports latency and throughput.

## 4. Data flow: one keystroke
1. User types "R" in browser A.
2. CodeMirror reports a change. The binding calls `localInsert(index, "R")`.
3. The CRDT creates an operation `{id: (clock, replica), origin, char}` and applies it locally. The screen updates immediately.
4. The operation goes to the outbox and is sent over the WebSocket.
5. Server validates, writes to Postgres, assigns `seq`, acknowledges to A, broadcasts to B (and to other server processes via Redis).
6. Browser B receives the operation, calls `applyRemote(op)`. If its origin character is missing, B parks the op in a pending buffer.
7. The CRDT updates its list. The binding turns the change into a CodeMirror transaction without moving B's cursor unexpectedly.

## 5. Data flow: offline then reconnect
1. Connection drops. The client keeps editing. Operations pile up in the outbox.
2. Client reconnects and sends `hello` with its `last_seq`.
3. Server replies with all operations after `last_seq`. Client applies them.
4. Client sends its outbox. Server deduplicates, stores, broadcasts.
5. Everyone converges.

## 6. Key design decisions

| # | Decision | Alternatives | Why |
|---|---|---|---|
| D1 | RGA with Lamport clocks | Logoot, LSEQ, Yjs/YATA, OT | Smallest algorithm that is correct and explainable |
| D2 | Clients merge, server relays | Server merges (OT style) | Offline editing falls out for free |
| D3 | Op log in Postgres, snapshots later | Store only latest state | Replay is simple and debuggable |
| D4 | JSON messages first | Binary encoding | Readable while learning; measure and optimise later |
| D5 | One-document-per-room fan-out | Global broadcast | Isolation and easy scaling |
| D6 | Cursors as character IDs | Cursors as indexes | Indexes go stale when text changes |
| D7 | Plain text only | Rich text | Keeps the learning focus on the CRDT |
| D8 | Array-backed list first, tree later | Start with a tree | Simple first; optimise only after measuring |

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| Client loses network | Keeps editing; banner shown; outbox grows |
| Duplicate operation delivered | Ignored (idempotent apply by ID) |
| Operation arrives before its origin | Held in pending buffer until the origin arrives |
| Server restarts | Clients reconnect, resync from `last_seq` |
| Redis down | Single-process broadcast still works; multi-process fan-out degraded; alert |
| Postgres down | Server rejects writes (no ack), clients keep outbox and retry |
| Message too large | Server rejects with error code; client splits batches |

## 8. Security basics
- Document IDs are random UUIDs (unguessable link sharing).
- Maximum message size and rate limit per connection.
- Reject unknown message types.
- Escape display names in the UI.
- No secrets in the repo; configuration through environment variables.

## 9. Observability
- Server metrics: connected clients, ops per second, broadcast latency, Postgres write latency, pending-buffer size.
- Client debug panel (see 3.2).
- Structured logs with `doc_id`, `replica_id`, `seq`.
