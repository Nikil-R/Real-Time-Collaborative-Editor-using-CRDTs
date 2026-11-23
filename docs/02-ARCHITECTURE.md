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

### 3.2 `packages/client` (`@rce/client`, TypeScript)
The sync logic, with no framework and no storage of its own, so the browser app and the load test share it. `DocSession` owns one replica, the outbox and the WebSocket:
- **Outbox:** a local edit is written to the store (IndexedDB in the browser) **before** it is sent, then batched (one batch per 30 ms) and removed on `ack`.
- **Reconnect:** jittered exponential backoff (500 ms doubling to 15 s), heartbeat ping every 20 s with a 10 s pong timeout, resend of everything unacknowledged on every new connection.
- **Seq watermark (`SeqTracker`):** the largest `S` such that every seq 1..S has been received. Broadcasts can arrive out of order and the sender never gets its own ops back (the `ack` lists their seqs), so only a contiguous watermark is safe to send as `last_seq`. A hole triggers `sync` after 1 s; a `pong` whose `head_seq` is ahead also triggers `sync`.
- **Snapshots:** uploads its state every 2,000 ops when idle and fully caught up; applies a snapshot from `welcome` and re-applies its own unacknowledged ops on top.
- **Presence:** cursor and selection as character ids, throttled to one message per 50 ms.
- Storage and sockets are injected (`LocalStore`, `SocketLike`), which is how it is tested against an in-memory fake server (`packages/client/test`).

### 3.2b `apps/web` (Next.js + React + TypeScript + CodeMirror 6)
Next.js is used as the frontend framework only. All editor, sync and offline code lives in client components (`"use client"`). There are no Next.js API routes: the backend is FastAPI.
- **Editor binding** (`src/lib/editor-binding.ts`): converts CodeMirror change sets into sequential CRDT edits, and remote `Change[]` into one composed CodeMirror change set, tagged with an annotation so it is not sent back.
- **Replica id per tab** (`src/lib/replica-id.ts`): a Web Lock on `(document, slot)` plus a stable id per slot in `localStorage`. A reload gets the same id and finds its IndexedDB outbox; a second tab gets another slot. Two editors with one id would diverge.
- **Offline store** (`src/lib/dexie-store.ts`): IndexedDB (Dexie) holds the outbox and a cached copy of the CRDT state, so a reload keeps unsent edits and the document opens offline.
- **Remote cursors** (`remote-cursors.ts`): CodeMirror decorations built from character ids resolved against the local replica after every change. Names are inserted with `textContent`.
- **Debug panel:** the character list with ids and tombstones, pending ops, clock, outbox, `last_seq`.
- **Zustand store:** UI mirror of the session (status, peers, counters).

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
4. The operation is written to the IndexedDB outbox, then sent over the WebSocket in a batch.
5. Server validates, writes to the database in one transaction, assigns gap-free `seq`, acknowledges to A (the ack lists the assigned seqs), broadcasts to B (and to other server processes via Redis).
6. Browser B receives the operation, calls `applyRemote(op)`. If its origin character is missing, B parks the op in a pending buffer.
7. The CRDT updates its list. The binding turns the change into a CodeMirror transaction without moving B's cursor unexpectedly.

## 5. Data flow: offline then reconnect
1. Connection drops. The client keeps editing. Operations pile up in the outbox.
2. Client reconnects (backoff) and sends `hello` with its contiguous `last_seq`.
3. Server replies with `welcome`: the operations after `last_seq` (one page; `more` and `sync` fetch the rest), or a snapshot plus later operations for a new or very stale client. Client applies them.
4. Client re-sends its whole outbox. Server deduplicates by `(replica, counter)`, stores, acks and broadcasts.
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
| D8 | Array-backed list first, tree later | Start with a tree | Simple first; optimise only after measuring (see `docs/results/`) |
| D9 | Gap-free `seq`, contiguous watermark on the client | Highest-seq-seen as `last_seq` | Broadcasts can reorder; a high-water mark would skip missed ops forever |
| D10 | One replica id per live editor (Web Lock + slot) | One id per browser profile | Two tabs sharing an id create colliding character ids |

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
