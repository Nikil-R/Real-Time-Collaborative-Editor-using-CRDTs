# 06 - Roadmap (day by day)

Total: 21 working days plus 3 buffer days. Each day has a **deliverable** and an **exit check**. Do not move on until the exit check passes.

Convention: commit at the end of every day with a message describing the deliverable.

---

## Week 0 - Setup (half a day, before Day 1)
- [ ] `git init`, create the folder layout from `README.md`.
- [ ] Node 20+, Python 3.11+, Docker installed.
- [ ] `packages/crdt` with TypeScript, Vitest and fast-check.
- [ ] Create a GitHub repo (private first).

---

## Week 1 - The CRDT core (the learning week)

### Day 1 - Data model and local edits
- Implement `CharId`, comparison function, `Node`, `Replica` skeleton.
- Implement `localInsert` and `localDelete` for a single replica, plus `getText()`.
- **Exit check:** unit tests for typing, deleting, inserting in the middle, empty document, and multi-character insert.

### Day 2 - Remote apply and the ordering rule
- Implement `integrate` (section 7 of `03-CRDT-DESIGN.md`) and `applyDelete`.
- Hand-written test for the Priya/Rahul example (result `CASRT` on both).
- **Exit check:** two replicas exchanging ops in both orders produce identical text.

### Day 3 - Pending buffer and idempotence
- Pending buffer for missing origins and delete targets.
- Duplicate handling.
- **Exit check:** tests deliver ops in reverse order, with duplicates, and replicas still converge.

### Day 4 - Property-based tests (most important day)
- Build a simulator: N replicas, random local edits, random delivery order, random delays and duplicates.
- Assertion: after all ops are delivered everywhere, all texts are equal.
- **Exit check:** 10,000 random schedules pass. Record the seed of any failure and fix the bug before moving on.

### Day 5 - Cursor helpers and change reporting
- `idAtIndex`, `indexOfId`, and `applyRemote` returning visible `Change[]` for the editor.
- Serialise and deserialise state (`getState`, `fromState`).
- **Exit check:** a round trip of state keeps the text and still accepts new ops; cursors stay attached to the right character after remote edits.

### Day 6 - Performance baseline
- Benchmark: insert 100,000 characters sequentially, random inserts, random deletes.
- Record time and memory in `docs/results/crdt-baseline.md`.
- **Exit check:** numbers recorded honestly with the machine description. No optimisation yet.

### Day 7 - Rest or catch-up
- Review `03-CRDT-DESIGN.md` against the code and update the doc where they differ.

---

## Week 2 - Network, server and editor

### Day 8 - Server skeleton
- FastAPI app, `/health`, create document endpoint, WebSocket endpoint with `hello` and `welcome`.
- Docker Compose with Postgres and Redis.
- **Exit check:** a script connects, receives `welcome`, and the log shows structured entries.

### Day 9 - Operation log
- Alembic migration for the schema in `05-DATABASE.md`.
- Handle `ops` batches: validate, de-duplicate, store in one transaction, assign `seq`, `ack`.
- **Exit check:** pytest for duplicate batches, concurrent writers, and server restart.

### Day 10 - Broadcast
- In-process fan-out to other clients of the same document.
- Catch-up on `hello` using `last_seq`.
- **Exit check:** two Node scripts using the CRDT package exchange edits through the server and converge.

### Day 11 - Web app skeleton
- Vite + React + CodeMirror 6, create or open document by URL.
- Editor shows text from the CRDT.
- **Exit check:** typing locally updates the CRDT and the screen.

### Day 12 - Editor binding
- CodeMirror transactions to `localInsert` and `localDelete`; remote `Change[]` to transactions.
- Guard against feedback loops (do not re-send remote-origin changes).
- **Exit check:** two browser tabs edit the same document live.

### Day 13 - Sync client
- WebSocket client with reconnect, backoff, heartbeat, `last_seq` tracking.
- **Exit check:** kill and restart the server while typing; both tabs recover and converge.

### Day 14 - Rest or catch-up
- Fix bugs found on Days 11-13; update `04-PROTOCOL.md` if messages changed.

---

## Week 3 - Offline, presence, scale, polish

### Day 15 - Offline outbox
- IndexedDB outbox, ack handling, replay on reconnect, persist replica ID and counters.
- **Exit check:** go offline in DevTools, type in both tabs, reconnect, both converge.

### Day 16 - Presence
- Cursor and selection as character IDs, names, colours, join and leave events.
- **Exit check:** remote cursors stay on the correct character during heavy typing.

### Day 17 - Persistence and snapshots
- Client-uploaded snapshots, `welcome` with snapshot, optional compaction job.
- **Exit check:** open a 50,000-character document and measure load time with and without snapshot.

### Day 18 - Multi-process fan-out
- Redis pub/sub, run two server processes behind a simple proxy.
- **Exit check:** two clients connected to different server processes converge.

### Day 19 - Load test and chaos test
- Load script with 10, 50, 100 simulated clients; record latency and throughput.
- Chaos: random disconnects, delayed and duplicated messages.
- **Exit check:** zero divergences; results saved in `docs/results/`.

### Day 20 - Yjs comparison and optimisation
- Run the same edit trace on Yjs and on the own CRDT; compare time, memory and encoded size.
- Pick one optimisation (chunked list or run-length encoding) and measure before and after.
- **Exit check:** a comparison table in the README with real numbers.

### Day 21 - Polish and ship
- Debug panel, README with GIF and architecture diagram, deploy (see `08-DEPLOYMENT.md`).
- Final check against the definition of done in `README.md`.

### Buffer days (22-24)
Use for overruns, bugs, or one stretch goal:
- Undo and redo of the local user's own edits.
- Simple rich text (bold) using extra attribute operations.
- Tombstone garbage collection.
- Server-side snapshot builder (Python port).

---

## Weekly review checklist
- Did every exit check pass?
- Are docs still true?
- What did I learn that I would not have learned from a tutorial? (Write it in `docs/learning-journal.md`.)
- Is anything on track to slip? Cut scope, not tests.

## What to cut first if behind
1. Redis multi-process (keep single process).
2. Yjs comparison (do a smaller comparison).
3. Snapshots (keep full-log replay).
4. Presence polish.
Never cut: property-based convergence tests, offline outbox, honest benchmarks.
