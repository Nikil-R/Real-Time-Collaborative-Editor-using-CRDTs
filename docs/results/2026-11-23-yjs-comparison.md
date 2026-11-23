# Own RGA CRDT versus Yjs on the same editing trace

Date: 2026-11-23
Machine: 11th Gen Intel Core i3-1115G4 @ 3.00 GHz, 7.8 GB RAM, Windows 11, Node v24.16.0 (`--expose-gc`)
Command: `pnpm bench:yjs` in `packages/crdt` (script: `packages/crdt/bench/yjs-compare.ts`)
Raw output: `docs/results/2026-11-23-yjs-compare.json`
Yjs version: the one pinned in `packages/crdt/package.json` (devDependency, used only by this script; the CRDT package has no runtime dependency).

## What was measured
A synthetic single-user trace from a fixed seed (42): about 70% typing at a moving cursor,
12% backspaces, cursor jumps, pastes of 5 to 40 characters and range deletes. It is **not** a
real editing trace. Both implementations applied the identical trace, and every result was
checked against a plain-string model (`textMatches: true` in all cells).

- **Local apply:** time to apply every edit locally (each Yjs edit in its own transaction).
- **Replay:** time for a fresh replica to apply what the first one produced. Own CRDT: all
  operations in order through `applyRemote`. Yjs: the same edits as separate incremental
  updates, and as one merged update.
- **Size:** own operations as JSON in the wire format of `04-PROTOCOL.md` (the format the
  server stores), own serialised state as JSON, Yjs merged update, Yjs incremental updates.

## Results (one run each)

| | 10,000 edits (11,464 chars) | 50,000 edits (59,301 chars) |
|---|---|---|
| Own: local apply | 200 ms | 7,075 ms |
| Yjs: local apply | 225 ms | 949 ms |
| Own: replay, in order | 333 ms | 9,751 ms |
| Yjs: replay, incremental updates | 107 ms | 439 ms |
| Yjs: replay, one merged update | 55 ms | 44 ms |
| Own: operations as JSON | 1,885,112 B | 9,661,410 B |
| Own: serialised state as JSON | 267,350 B | 1,404,085 B |
| Yjs: merged update | 76,828 B | 415,296 B |
| Yjs: incremental updates, total | 251,947 B | 1,356,457 B |

Ratios computed from the table (own divided by Yjs), at 50,000 edits: local apply 7.5x
slower, replay 22x slower than incremental Yjs updates, operations JSON 23x larger than the
merged Yjs update (7.1x larger than the incremental updates), state JSON 3.4x larger than
the merged update. At 10,000 edits local apply is on par (0.9x), replay is 3.1x slower.

## Reading the result honestly
- Being slower and larger than Yjs is expected: Yjs stores runs of characters as single
  items and uses a binary encoding; this implementation has one node per character, JSON
  messages and a linear array (`03-CRDT-DESIGN.md` section 14 lists run-length encoding,
  a tree index and binary encoding as the planned improvements, none of them done).
- The growth is the main point: going from 10,000 to 50,000 edits made the own local apply
  35x slower and Yjs 4.2x slower, which is the O(n) scan per edit showing.
- Memory is **not** compared. Heap deltas from `--expose-gc` were recorded in the JSON but
  one of them is negative (the garbage collector ran during the scenario), so they are not
  reliable and no memory claim is made.
- Single runs on a laptop that shows large run-to-run variance (see
  `2026-11-23-crdt-optimisation.md`); treat ratios as order of magnitude.
