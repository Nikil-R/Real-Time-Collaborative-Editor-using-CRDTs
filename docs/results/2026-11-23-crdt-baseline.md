# CRDT baseline performance (array-backed list, before any optimisation)

Date: 2026-11-23
Machine: 11th Gen Intel Core i3-1115G4 @ 3.00 GHz, 7.8 GB RAM, Windows 11
Versions: Node v24.16.0 (`--expose-gc`), TypeScript run through tsx
Command: `pnpm bench` in `packages/crdt` (script: `packages/crdt/bench/baseline.ts`)
Raw output: `docs/results/2026-11-23-crdt-baseline.json`

Single run per cell. A few short commands (typechecks, file writes) ran on the same machine
while this was running, so treat timings as rough and re-run on a quiet machine before
quoting them anywhere. Sizes above 30,000 are not shown for the quadratic scenarios because
they would take far too long, which is itself the finding.

| Scenario | n | Time |
|---|---|---|
| One paste of n characters (chain of inserts) | 1,000 | 5.0 ms |
| | 10,000 | 39.2 ms |
| | 100,000 | 327.7 ms |
| Type n characters one by one at the end | 1,000 | 54.0 ms |
| | 10,000 | 728.4 ms |
| | 30,000 | 7,175 ms |
| n random single-character inserts | 1,000 | 121.8 ms |
| | 10,000 | 10,745 ms |
| | 30,000 | 139,135 ms |
| n random single-character deletes (on an n-character text) | 1,000 | 30.3 ms |
| | 10,000 | 355.2 ms |
| | 30,000 | 6,647 ms |
| Apply n remote inserts one at a time, in order | 1,000 | 7.7 ms |
| | 10,000 | 202.2 ms |
| | 30,000 | 5,973 ms |

Heap deltas were recorded in the JSON but are not reliable (some are negative because the
garbage collector ran during a scenario); no memory claim is made from this run.

## Reading the numbers
- One-at-a-time editing is quadratic: 10x more characters costs about 10x to 13x more per
  character. Random inserts are the worst case: 30,000 inserts take over two minutes.
- A paste is cheap because the chain of inserts appends at the end and reindexes nothing.
- Typing at normal human speed in a document of a few thousand characters is fine today;
  the slow cases matter for large documents and for the load test.
- Likely cost centres: rebuilding the position index (string keys created for every node
  after the insertion point on every insert), and the linear scans for visible offsets.
