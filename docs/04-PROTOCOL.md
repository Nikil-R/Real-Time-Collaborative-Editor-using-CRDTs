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
{ "type": "hello", "last_seq": 1204, "replica": "r-8f2c", "name": "Priya", "color": "#e57373" }
```
`last_seq` is the highest `seq` the client has applied (0 for a new client).

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

### 2.4 `ping`
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
  "ops_since": [ /* ops with seq > last_seq, each includes "seq" */ ],
  "head_seq": 1260,
  "peers": [ { "replica": "r-1a3b", "name": "Rahul", "color": "#64b5f6" } ]
}
```
If `last_seq` is older than the oldest retained operation (because of compaction), `snapshot` contains the document state and `ops_since` contains only operations after the snapshot.

### 3.2 `ack`
Confirms a batch is stored.
```json
{ "type": "ack", "batch_id": "b-77", "max_seq": 1262 }
```
The client may now delete those ops from its outbox.

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
{ "type": "pong", "t": 1732352000000 }
```

### 3.7 `error`
```json
{ "type": "error", "code": "BAD_MESSAGE", "message": "ops batch too large" }
```
Codes: `BAD_MESSAGE`, `TOO_LARGE`, `RATE_LIMITED`, `DOC_NOT_FOUND`, `INTERNAL`.

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

## 6. Versioning
- First message after connect includes `"v": 1` in `hello`. The server rejects unknown versions with `BAD_MESSAGE`.
- Any change to message shapes bumps the version and updates this document in the same commit.
