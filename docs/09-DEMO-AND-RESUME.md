# 09 - Demo, Resume and Interview Preparation

## 1. 60-second demo script
1. Open the live link in two windows side by side. Different names appear with coloured cursors.
2. Type in both at the same time in the same sentence. Both end up identical. Say: "No locking, no last-write-wins."
3. Turn off the network in window B (DevTools offline). Keep typing in both windows. Show the "offline, saved locally" banner.
4. Turn the network back on. Texts merge and match. Say: "The server never decided who wins. Both browsers computed the same result."
5. Open the debug panel. Show character IDs and a tombstone. Say: "Deleted characters stay as tombstones so concurrent edits still refer to something valid."
6. Show the results table: convergence tests, latency numbers, comparison with Yjs.

## 2. Resume bullets (fill in only with measured numbers)
Use these templates and replace every `X`, `Y`, `N` with real values from `docs/results/`.

- "Built a real-time collaborative text editor on a from-scratch RGA CRDT in TypeScript; verified convergence with property-based testing over N random multi-replica schedules (0 divergences)."
- "Designed a WebSocket sync layer (FastAPI, PostgreSQL operation log, Redis pub/sub) supporting offline editing and resync; p99 propagation latency of X ms with N concurrent clients."
- "Implemented client-side outbox with IndexedDB and idempotent operation de-duplication, so edits made offline merge without conflicts after reconnecting."
- "Benchmarked against Yjs: X percent of its throughput and Y times its memory on a Z-operation trace; optimised the list structure with run-length encoding, improving apply time by W percent."

Rules: never claim numbers that are not in a results file. If a result is poor, say what you learned and what you would change.

## 3. GitHub README checklist
- One-line pitch and a GIF at the top.
- Architecture diagram (from `02-ARCHITECTURE.md`).
- "How it works" in plain English (the Priya and Rahul example).
- Results table with date, machine and command.
- Honest limitations (tombstones, interleaving, plain text only).
- How to run locally in three commands.
- Link to the live demo (and a note on whether it is currently running).

## 4. LinkedIn or portfolio blurb (draft)
"I built a collaborative editor from scratch to understand how tools like Google Docs keep everyone in sync. Instead of locking or last-write-wins, every character has a permanent ID, so edits made at the same time (or offline) always merge to the same text. Includes a CRDT written from scratch, tested with thousands of random schedules, and benchmarked against Yjs."

## 5. Interview questions you should be able to answer
1. What is a CRDT and what guarantee does it give? (Strong eventual consistency: same ops in any order give the same state.)
2. Why not just use timestamps and last-write-wins? (Loses edits; clocks disagree.)
3. How does RGA decide order for two inserts at the same spot? (Compare IDs; skip over larger IDs after the origin.)
4. Why are deleted characters kept? (Concurrent ops may reference them; tombstones keep references valid.)
5. What happens if an operation arrives before the one it depends on? (Buffered in a pending list until the dependency exists.)
6. How do you handle duplicates? (Idempotent apply by ID; server de-duplicates by replica and counter.)
7. CRDT versus operational transform? (OT needs a central ordering and complex transformation functions; CRDTs merge anywhere, at the cost of metadata.)
8. What is the cost of CRDTs? (Metadata per character, tombstones, harder garbage collection.)
9. How did you test correctness? (Property-based tests over random delivery orders; chaos tests.)
10. How would you scale to many documents and users? (Shard by document, Redis fan-out, snapshots and compaction.)
11. What would you change with more time? (Tree-based index, run-length encoding, tombstone GC, rich text.)
12. What is the interleaving problem? (Concurrent typed words can mix characters; known limitation of simple sequence CRDTs; newer algorithms reduce it.)
13. Why store cursors as IDs? (Index positions go stale when text changes.)
14. How does offline editing work? (Clients own the merge; offline is just late delivery.)

## 6. Honest-claims rules
- Say "implemented RGA from scratch" only if the CRDT package really has no CRDT dependency.
- If Yjs is used for comparison, say so.
- Do not say "production-ready". Say "demo-scale, tested with N simulated clients".
- Mention what you did not build (rich text, auth, tombstone garbage collection) before an interviewer asks.

## 7. Optional follow-ups for the portfolio
- Blog post: "How two people typing at once end up with the same text" with the interactive dry run.
- Short screen recording with captions.
- Small interactive page that visualises operations and the character list for teaching.
