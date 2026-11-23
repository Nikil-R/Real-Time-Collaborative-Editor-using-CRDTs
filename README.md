# Real-Time Collaborative Editor using CRDTs

A real-time collaborative text editor where many people type in the same document at once, work offline, and always end up with identical text on every device. The merge logic is a CRDT (RGA: Replicated Growable Array) written from scratch, then compared against Yjs.

**Author:** Nikil R
**Status:** Planning complete, implementation not started
**Created:** 2026-11-23
**Time budget:** about 3 weeks (21 working days plus 3 buffer days)

---

## Why this project

- Learn a topic that the delivery API and LegalFinance AI projects did not touch: **distributed-systems merging, WebSockets, and conflict-free data structures**.
- Produce a result that is easy to demonstrate in 30 seconds (two browser windows, one document, one offline).
- Produce numbers that can go on a resume: convergence under random fuzzing, propagation latency, concurrent users supported.

## The one-paragraph explanation

Every character gets a permanent unique ID. An edit says "insert this character after the character with ID X", not "insert at position 5". Because the meaning of an edit never depends on what else changed, edits can arrive in any order, twice, or after being held offline, and every device still ends up with the same text. The server only relays and stores edits. It never decides who wins.

## Repository layout (to be created during implementation)

```
Real-Time-Collaborative-Editor-using-CRDTs/
  README.md                  this file
  docs/PROJECT-RULES.md                  context for AI assistants working in this repo
  docs/
    01-PRD.md                goals, non-goals, user stories, success metrics
    02-ARCHITECTURE.md       components, data flow, tech choices, decisions
    03-CRDT-DESIGN.md        the algorithm: IDs, insert, delete, ordering, proofs
    04-PROTOCOL.md           WebSocket messages and sync rules
    05-DATABASE.md           Postgres schema, snapshots, compaction
    06-ROADMAP.md            day-by-day plan with exit criteria
    07-TESTING.md            unit, property-based, fuzz, load, chaos tests
    08-DEPLOYMENT.md         Docker, AWS, environment, observability
    09-DEMO-AND-RESUME.md    demo script, resume bullets, interview Q and A
    10-GLOSSARY.md           plain-English glossary
  packages/crdt/             TypeScript CRDT library (the learning core)
  apps/web/                  React + CodeMirror 6 editor
  server/                    FastAPI WebSocket relay + Postgres + Redis
  loadtest/                  simulated users, benchmarks
```

## Tech stack

| Layer | Choice | Reason |
|---|---|---|
| CRDT core | TypeScript, no dependencies | Runs in the browser, easy to test with fast-check |
| Editor | React + Vite + CodeMirror 6 | CodeMirror gives clean change objects to convert into operations |
| Server | Python FastAPI + WebSockets | Matches existing skills |
| Storage | PostgreSQL | Append-only operation log plus snapshots |
| Scale-out | Redis pub/sub | Share edits between several server processes |
| Offline | IndexedDB | Queue edits while disconnected |
| Tests | Vitest, fast-check, pytest, a custom load script | Property-based tests are the key proof of correctness |
| Deploy | Docker Compose locally, AWS EC2 or ECS later | Matches existing AWS experience |

## Reading order

1. `docs/01-PRD.md` to know what "done" means.
2. `docs/03-CRDT-DESIGN.md` because it is the heart of the project.
3. `docs/06-ROADMAP.md` to start working day by day.

## Definition of done

- Two or more browsers edit one document live and always converge.
- A client can go offline, keep typing, reconnect, and merge cleanly.
- Property-based tests show convergence on at least 10,000 random edit schedules.
- A load test reports latency and throughput with real numbers.
- README contains a demo GIF, architecture diagram and a results table.
