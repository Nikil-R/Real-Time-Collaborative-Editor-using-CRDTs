# 05 - Database Design (PostgreSQL)

## 1. Principles
- The **operation log is the source of truth**. The current document is whatever you get by replaying it.
- The server stores operations as opaque JSON. It does not understand characters or ordering.
- Snapshots are a performance optimisation, never the truth.

## 2. Schema

```sql
CREATE TABLE documents (
  id            UUID PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT 'Untitled',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seq      BIGINT NOT NULL DEFAULT 0,       -- highest seq assigned so far
  last_activity TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE operations (
  doc_id        UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq           BIGINT NOT NULL,                  -- per-document, increasing
  op_replica    TEXT NOT NULL,                    -- replica that created the op
  op_counter    BIGINT NOT NULL,                  -- per-replica counter
  payload       JSONB NOT NULL,                   -- the op body (kind, id, origin, ch, target)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq),
  UNIQUE (doc_id, op_replica, op_counter)         -- de-duplication
);

CREATE TABLE snapshots (
  doc_id        UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  up_to_seq     BIGINT NOT NULL,                  -- snapshot includes every op with seq <= this
  state         JSONB NOT NULL,                   -- serialised CRDT state
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, up_to_seq)
);

CREATE INDEX operations_doc_seq_idx ON operations (doc_id, seq);
```

## 3. Assigning `seq`
Must be gap-tolerant but strictly increasing per document, and safe under concurrent writers.

```sql
-- inside one transaction per batch
UPDATE documents SET last_seq = last_seq + $n, last_activity = now()
WHERE id = $doc_id
RETURNING last_seq;                               -- gives the top of the reserved range
-- then insert operations with seq = (top - n + 1) .. top
```
The row-level lock taken by the `UPDATE` serialises writers for the same document and keeps different documents independent. Duplicate ops (unique violation) are skipped with `INSERT ... ON CONFLICT DO NOTHING`, and the unused reserved numbers are allowed to be gaps.

## 4. Reads
- **Catch-up:** `SELECT seq, payload FROM operations WHERE doc_id = $1 AND seq > $2 ORDER BY seq LIMIT 5000` (page through if more).
- **Latest snapshot:** `SELECT * FROM snapshots WHERE doc_id = $1 ORDER BY up_to_seq DESC LIMIT 1`.

## 5. Snapshots and compaction

### Why
Replaying a million operations to open a document is slow. A snapshot lets a new client load the state directly and fetch only the later operations.

### Who builds the snapshot
Default plan: **a client uploads it.** The server stays free of CRDT logic.
1. A connected client that has applied every op up to `seq = S` serialises its CRDT state.
2. It sends `{type: "snapshot", up_to_seq: S, state: …}` (a message to add in protocol v1.1).
3. The server stores it only if `S` is at or below `last_seq` and no newer snapshot exists.
4. Safety: two clients computing a snapshot at the same `seq` must produce equivalent states. A test checks this.

Alternative (stretch): a Python port of the CRDT on the server builds snapshots. It costs duplicated logic but removes trust in clients.

### Compaction
- After a snapshot at `S`, operations with `seq <= S` may be deleted if no replica can still need them. Policy: keep a safety window, for example 7 days or the last 10,000 operations, whichever is larger.
- A client whose `last_seq` is older than the retained range receives `snapshot` in `welcome` (see protocol).
- Tombstone garbage collection is a separate, harder step and is explicitly optional (see `03-CRDT-DESIGN.md` section 14).

## 6. Retention and cleanup
- Documents untouched for N days can be archived or deleted (configurable).
- Deleting a document cascades to operations and snapshots.

## 7. Capacity thinking (to verify with real measurements)
- One insert op is roughly 120 to 200 bytes as JSON, so a 10,000-character document that was typed once is around 1 to 2 MB of log. Measure the real number and record it in the README.
- Each snapshot is similar in size to the node list. Record the ratio of snapshot size to visible text size.

## 8. Migrations
- Use Alembic. First migration creates the three tables.
- Each later change (snapshot message, retention) ships as a migration plus a note in the changelog.

## 9. Testing the database layer
- Concurrent writers to one document produce a gap-tolerant strictly increasing `seq` with no duplicates.
- Re-sending the same batch stores nothing new.
- Catch-up paging returns operations in order with no omissions.
- Killing the server mid-batch never leaves a half-stored batch (single transaction per batch).
