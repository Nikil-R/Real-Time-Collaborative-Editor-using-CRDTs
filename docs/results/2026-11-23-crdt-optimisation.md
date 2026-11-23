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

## Final run on an idle machine
After the runs above, the whole benchmark was run once more with nothing else active on
the machine (no other heavy job running, only light file edits; same script and sizes). Raw output:
`2026-11-23-crdt-final-quiet.json`. Time in milliseconds, one run each.

| Scenario | n | Baseline | Final (idle machine) | Baseline / final |
|---|---|---|---|---|
| one paste of n chars (chain of inserts) | 1,000 | 5.0 | 2.3 | 2.1x |
| one paste of n chars (chain of inserts) | 10,000 | 39.2 | 11.1 | 3.5x |
| one paste of n chars (chain of inserts) | 100,000 | 327.7 | 135.4 | 2.4x |
| type n chars one by one at the end | 1,000 | 54.0 | 16.3 | 3.3x |
| type n chars one by one at the end | 10,000 | 728.4 | 267.2 | 2.7x |
| type n chars one by one at the end | 30,000 | 7,175.2 | 2,825.0 | 2.5x |
| n random single-char inserts | 1,000 | 121.8 | 2.7 | 45.7x |
| n random single-char inserts | 10,000 | 10,745.4 | 122.5 | 87.7x |
| n random single-char inserts | 30,000 | 139,135.0 | 1,601.2 | 86.9x |
| n random single-char deletes  | 1,000 | 30.3 | 12.8 | 2.4x |
| n random single-char deletes  | 10,000 | 355.2 | 388.4 | 0.9x |
| n random single-char deletes  | 30,000 | 6,647.3 | 5,717.0 | 1.2x |
| apply n remote inserts one op at a time (in order) | 1,000 | 7.7 | 6.4 | 1.2x |
| apply n remote inserts one op at a time (in order) | 10,000 | 202.2 | 274.2 | 0.7x |
| apply n remote inserts one op at a time (in order) | 30,000 | 5,973.4 | 5,938.8 | 1.0x |

What holds: random single-character inserts are about 87x faster at 10,000 and 30,000
characters (the earlier noisy runs agreed in direction: at least 3.5x and 5.6x). Typing at the
end and pasting are about 2x to 3.5x faster. Deletes and in-order remote apply did not
improve (ratios between 0.7x and 1.2x are within the noise seen between runs), because they
still scan for visible offsets. The baseline itself was taken while short commands ran on the
machine, so its times may be inflated, which would overstate the ratios above.
