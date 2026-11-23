# CRDT convergence runs (property-based)

Date: 2026-11-23
Machine: 11th Gen Intel Core i3-1115G4 @ 3.00 GHz, 7.8 GB RAM, Windows 11
Versions: Node v24.16.0, vitest 5.1.1, fast-check 4.11.0, TypeScript 7.0.2
Command: `FC_RUNS=<n> pnpm exec vitest run` in `packages/crdt` (also `pnpm test:crdt:full` for n = 10000)

## What a "schedule" is
`test/simulator.ts` generates 2 to 6 replicas, up to 80 random steps (local inserts with
emoji and newlines, deletes, deliveries of one queued op to one replica in random order,
deliveries that leave a copy in the queue = duplicates), then delivers everything left in a
seeded random order with extra duplicates.

## Results

| Runs per property | Properties using that count | Result | Wall time (whole suite) |
|---|---|---|---|
| 2,000 (default) | 1, 2, 3, 4-6 | all pass | about 2.5 s |
| 10,000 | 1, 2, 3, 4-6 | all pass, 0 divergences | 17.3 s |
| 100,000 | 1, 2, 3, 4-6 | all pass, 0 divergences | 129.1 s |

Properties 7 (serialisation round trip) and "changes reproduce the text" are capped at
1,000 runs each; the wire-codec round trip runs 300. See `test/convergence.property.test.ts`.

## Sanity check that the tests can fail
Replacing the replica tie-break in `compareIds` with "always equal" made the convergence
and order-independence properties fail (plus the hand-written Priya/Rahul test). The change
was reverted. Reversing the skip comparison also failed immediately.

## Limits of this evidence
- Fuzzing is empirical, not a formal proof (see `03-CRDT-DESIGN.md` section 12).
- The simulator uses small alphabets and short documents on purpose, to force collisions.

## Re-runs after the optimisations (same day)
The position-index change and position hint were made after the table above, so the suite was
run again against the final code.

| Runs per property | Result | Wall time |
|---|---|---|
| 10,000 | all 62 tests pass | 5.4 s (machine otherwise idle) |
| 100,000 | all 62 tests pass | 307.6 s: **not comparable**, other jobs (server tests, a load smoke test) were running on the machine at the same time |
