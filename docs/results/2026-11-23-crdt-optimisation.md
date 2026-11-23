# CRDT position-index optimisation (before and after)

Date: 2026-11-23
Machine: 11th Gen Intel Core i3-1115G4 @ 3.00 GHz, 7.8 GB RAM, Windows 11, Node v24.16.0
Command: `pnpm bench` in `packages/crdt` (`bench/baseline.ts`, identical sizes each time)

## Change
`index: Map<idKey, position>` (rebuilt from the insertion point after every insert, creating
a string key per node) became `Map<idKey, Node>`, with positions found by `Array.indexOf`
plus a self-validating "last inserted position" hint. Rationale: the baseline showed
random inserts and one-at-a-time typing growing quadratically.

## Raw runs (milliseconds, one run each; JSON files next to this document)

| Scenario | n | baseline | index change only | + hint, run 1 | + hint, run 2 |
|---|---|---|---|---|---|
| paste n chars | 100,000 | 327.7 | 2,378.6 | 178.9 | 368.3 |
| type n chars one by one | 10,000 | 728.4 | 256.6 | 440.7 | 445.0 |
| type n chars one by one | 30,000 | 7,175 | 3,255 | 8,403 | 38,979 |
| n random inserts | 10,000 | 10,745 | 145.9 | 352.7 | 3,108 |
| n random inserts | 30,000 | 139,135 | 2,828 | 6,543 | 24,836 |
| n random deletes | 30,000 | 6,647 | 6,142 | 28,076 | 120,791 |
| apply n remote inserts | 30,000 | 5,973 | 6,942 | 11,866 | 32,208 |

## How far to trust this
Run-to-run variance on this machine is very large (the same code differs by up to 20x
between runs; other programs and my own tool calls were running during several of them, and
the laptop CPU may throttle). **Only one conclusion holds across every run:** random inserts
at 10,000 and 30,000 characters are at least 3.5x and 5.6x faster than the baseline (best
runs: about 70x and 49x). Everything else here is inconclusive: deletes and in-order remote
apply did not improve, because they still scan for visible offsets, which this change does
not touch.

The first version of the change (index only) made a 100,000-character paste 7x slower,
because each pasted character then scanned for its origin. The position hint fixed that
(178.9 to 368.3 ms, against 327.7 ms before).

Next candidates, not done: a chunked list with per-chunk visible counts (design section 14,
item 1) would remove the remaining linear scans.
