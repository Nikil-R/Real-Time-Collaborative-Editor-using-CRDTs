# 04 - WebSocket Protocol

All messages are JSON objects with a `type` field. Version 1 uses plain JSON for readability. Binary encoding is an optional later optimisation.

Endpoint: `ws://host/ws/{doc_id}?replica={replica_id}&name={display_name}`

## 1. Identifiers used in messages
- `doc_id`: UUID string.
- `replica_id`: random string generated once per browser profile and stored locally (stable across reloads, so the same replica keeps the same IDs and counters).
- `op_id`: `{ "r": replica_id, "n": counter }`, where `n` is a per-replica counter that increases by one for every op sent. Used by the server for de-duplication.
- `seq`: per-document integer assigned by the server in the order operations were stored. Used only for catching up after disconnects. It plays no part in CRDT ordering.

## 2. Client to server

### 2.1 `hello`
Sent first after connecting.
```json
{ "type": "hello", "v": 1, "last_seq": 1204, "replica": "r-8f2c", "name": "Priya", "color": "#e57373" }
```
`last_seq` is the highest `seq` the client has applied (0 for a new client). `v` must be `1`. `replica` must not already be connected to this document (on any server process): otherwise the server replies with `REPLICA_IN_USE` and closes. A browser must therefore use one replica id **per tab**, not per profile (see section 6).

### 2.2 `ops`
A batch of operations created locally.
```json
{
  "type": "ops",
  "batch_id": "b-77",
  "ops": [
    { "op_id": {"r":"r-8f2c","n":41}, "kind": "ins", "id": {"c":12,"r":"r-8f2c"}, "origin": {"c":9,"r":"r-1a3b"}, "ch": "R" },
    { "op_id": {"r":"r-8f2c","n":42}, "kind": "del", "target": {"c":7,"r":"r-1a3b"} }
  ]
}
```
Limits: at most 500 ops per batch and 256 KB per message.

### 2.3 `presence`
Cursor and selection, sent at most every 50 ms and only when changed.
```json
{ "type": "presence", "anchor": {"c":12,"r":"r-8f2c"}, "head": {"c":14,"r":"r-8f2c"} }
```
Anchor and head are character IDs, or `null` for "start of document". Presence is **not** stored in the database.

### 2.4 `snapshot` (v1.1, additive)
A client uploads its serialised CRDT state so new clients can load it instead of replaying the whole log (see `05-DATABASE.md` section 5).
```json
{ "type": "snapshot", "up_to_seq": 1260, "state": { "...": "output of Replica.getState()" } }
```
The server stores it only if `up_to_seq` is at most the document's `last_seq` and newer than the stored snapshot. No reply.

### 2.5 `sync` (v1.1, additive)
Ask for the next page of operations after `last_seq` (used when `welcome.more` or `catchup.more` is true).
```json
{ "type": "sync", "last_seq": 5000 }
```

### 2.6 `ping`
```json
{ "type": "ping", "t": 1732352000000 }
```

## 3. Server to client

### 3.1 `welcome`
Reply to `hello`.
```json
{
  "type": "welcome",
  "doc_id": "…",
  "snapshot": null,
  "ops_since": [ /* first page: ops with seq > last_seq (or > snapshot.up_to_seq), each includes "seq" */ ],
  "more": false,
  "head_seq": 1260,
  "peers": [ { "replica": "r-1a3b", "name": "Rahul", "color": "#64b5f6" } ]
}
```
`snapshot` is sent when a snapshot newer than `last_seq` exists and either the client is new (`last_seq` is 0) or its `last_seq` is older than the oldest retained operation (because of compaction). `ops_since` then contains only operations after the snapshot. `ops_since` holds at most one page (default 5000 operations); when `more` is true the client sends `sync` until it receives `more: false`.

### 3.1b `catchup` (v1.1, additive)
Reply to `sync`.
```json
{ "type": "catchup", "ops": [ ... ], "more": true, "head_seq": 12000 }
```

### 3.2 `ack`
Confirms a batch is stored.
```json
{ "type": "ack", "batch_id": "b-77", "max_seq": 1262, "seqs": [1261, 1262] }
```
The client may now delete those ops from its outbox. `seqs` (v1.1, additive) lists the seq of every operation in the batch, in order, including operations that were already stored (duplicates keep their original seq). The sender never receives its own operations back, so this is how it learns which seq numbers they occupy and keeps its contiguous watermark moving.

### 3.3 `ops` (broadcast)
Operations from other clients. Same op shape as the client message, plus `seq`.
```json
{ "type": "ops", "ops": [ { "seq": 1263, "op_id": {...}, "kind": "ins", ... } ] }
```

### 3.4 `presence` (broadcast)
```json
{ "type": "presence", "replica": "r-1a3b", "name": "Rahul", "color": "#64b5f6", "anchor": {...}, "head": {...} }
```

### 3.5 `peer_joined` and `peer_left`
```json
{ "type": "peer_joined", "replica": "r-1a3b", "name": "Rahul", "color": "#64b5f6" }
{ "type": "peer_left", "replica": "r-1a3b" }
```

### 3.6 `pong`
```json
{ "type": "pong", "t": 1732352000000, "head_seq": 1263 }
```
`head_seq` (v1.1, additive) is the document's highest seq. A client whose contiguous watermark is below it sends `sync`. This repairs a lost broadcast when nothing newer arrives to reveal the hole.

### 3.7 `error`
```json
{ "type": "error", "code": "BAD_MESSAGE", "message": "ops batch too large" }
```
Codes: `BAD_MESSAGE`, `TOO_LARGE`, `RATE_LIMITED`, `DOC_NOT_FOUND`, `REPLICA_IN_USE`, `INTERNAL`. `DOC_NOT_FOUND` and `REPLICA_IN_USE` close the connection; the others leave it open. A batch refused with `RATE_LIMITED` or `INTERNAL` is not stored and not acknowledged: the client keeps it in its outbox and retries.

## 4. Sync rules

1. **Connect:** client sends `hello`; server replies with `welcome`. The client applies `snapshot` then `ops_since`, then flushes its outbox.
2. **Normal editing:** apply local ops immediately, send them in a batch, keep them in the outbox until `ack`.
3. **Server de-duplication:** a unique constraint on `(doc_id, op_replica, op_counter)`. A repeated op is acknowledged but not stored or broadcast again.
4. **Client idempotence:** the CRDT itself ignores repeated inserts and repeated deletes, so broadcasts that arrive twice do no harm.
5. **Reconnect:** exponential backoff starting at 500 ms, doubling up to 15 s, with random jitter. Always re-send `hello` with the latest `last_seq`.
6. **Ordering:** the network may deliver ops in any order. The CRDT's pending buffer handles missing dependencies.
7. **Heartbeat:** client sends `ping` every 20 s. If no `pong` within 10 s, treat the connection as dead and reconnect.
8. **Back-pressure:** if a client is slow, the server drops it after its send buffer exceeds a limit. The client then reconnects and resyncs.
9. **Outbox batching:** send at most one batch per 30 ms while the user types, to reduce messages without noticeable delay.

## 5. Multi-process fan-out
- When server process P1 stores a batch, it publishes it to Redis channel `doc:{doc_id}`.
- Every process subscribed to that channel forwards the message to its local clients except the sender.
- The database is the source of truth. If Redis drops a message, a client will catch up from `last_seq` the next time it reconnects, and the server can also send a "resync" hint when it detects a gap.

## 6. Replica ids
- `replica_id` is the identity inside every character id. Two live editors sharing one id would create different characters with the same id and diverge, so an id must belong to exactly one live editor.
- The web app generates one id per **tab** (kept in `sessionStorage` so a reload keeps the same id and its IndexedDB outbox) and guards it with a Web Lock; a duplicated tab detects the clash and takes a new id. The server enforces the same rule with `REPLICA_IN_USE`.

## 7. Versioning
- First message after connect includes `"v": 1` in `hello`. The server rejects unknown versions with `BAD_MESSAGE`.
- Additive messages (v1.1: `snapshot`, `sync`, `catchup`, `more`, `REPLICA_IN_USE`) keep `v: 1`; a message that changes the meaning of an existing field bumps `v`. Update this document in the same commit as any change.
- A `ops` message may carry presence-free CRDT operations only; the server validates shape (`op_id`, `kind`, and the fields each kind needs) and stores the rest untouched.

## 8. Workspaces: REST API and the project channel (v1.1, additive)

A **project** is a set of files; every file is an ordinary document (section 1 to 7 apply to
it unchanged, one WebSocket per open file). The project channel never carries operations.

### REST
| Method and path | Purpose |
|---|---|
| `POST /api/projects` `{name}` | Create a project with starter files. Returns `{id, name, files}`. |
| `GET /api/projects/{id}` | `{id, name, files:[{id, name, created_at}]}` (deleted files omitted). |
| `POST /api/projects/{id}/files` `{name}` | Create a file. `409` if the name exists (case-insensitive), `422` for an invalid name. |
| `PATCH /api/projects/{id}/files/{file_id}` `{name}` | Rename. |
| `DELETE /api/projects/{id}/files/{file_id}` | Soft delete (the operation log is kept); the file can no longer be opened. |
| `GET /api/projects/{id}/activity?limit=50` | `{events:[...]}`, newest first. |
| `POST /api/files/{file_id}/claim-seed` | `{text}` with the file's starter text for the first caller, `{text: null}` for everyone else. The server cannot build CRDT operations, so exactly one client types the starter text in. |

An optional `X-Actor` header names the person for the activity feed. Names are paths such as
`src/app.ts` (1 to 120 characters, no empty segments, no `..`, no backslashes or control characters).

### `/ws/projects/{project_id}`
Client to server: `hello` (same fields as section 2.1; `replica` identifies the browser tab), `focus`
`{file_id: uuid | null}` (which file this person has open), `ping`.

Server to client:
```json
{ "type": "welcome", "project": {"id": "…", "name": "…"}, "files": [ ... ],
  "peers": [ {"replica": "…", "name": "…", "color": "#…", "file_id": "… or null"} ],
  "activity": [ /* newest first */ ] }
{ "type": "files_changed", "files": [ ... ] }
{ "type": "focus", "replica": "…", "name": "…", "color": "#…", "file_id": "…" }
{ "type": "activity", "event": {"id": 7, "ts": "…", "actor": "Priya", "kind": "edit", "file_id": "…", "file_name": "src/app.ts", "count": 42} }
{ "type": "peer_joined" | "peer_left" | "pong" | "error" }
```
`kind` is `file_created`, `file_renamed`, `file_deleted` or `edit`. Edit activity is collected in
memory and written every few seconds, merged per person and file (same person, same file, within
60 s: one entry with a growing `count`). Messages are fanned out through Redis like document
messages, on the room key `project:{id}`.
