# 01 - Product Requirements

## 1. Problem statement
When two people edit the same text at the same moment, naive approaches lose edits or let copies drift apart. Existing solutions are either "one person at a time" (locking) or "last write wins" (data loss). Modern tools use CRDTs or operational transform. This project builds a working editor on a CRDT to learn how and why it works.

## 2. Goals
- G1. Multiple users edit one document live and always converge to identical text.
- G2. A user can go offline, keep editing, and merge cleanly on reconnect.
- G3. Show other people's cursors and names live.
- G4. The document survives server restarts.
- G5. Prove correctness with automated tests, not just manual demos.
- G6. Measure and publish performance numbers honestly.

## 3. Non-goals (explicitly out of scope)
- Rich text formatting (bold, headings, images). Plain text only. Mark as a possible stretch.
- User accounts, passwords or permissions. Documents are shared by unguessable link.
- Mobile apps.
- Replacing Yjs for production use.
- End-to-end encryption.

## 4. Users and user stories
**Primary user:** a person who wants to write or edit text with others in real time.

| ID | Story | Acceptance |
|---|---|---|
| U1 | As a user I open a link and see the document | Document text appears within 1 second on a normal connection |
| U2 | As a user I type and others see it quickly | Remote edits appear within 100 ms on a local network |
| U3 | As a user I see who else is here | Each person has a name and colour; their cursor and selection show |
| U4 | As a user I keep typing when my internet drops | Typing never blocks; a banner says "offline, changes saved locally" |
| U5 | As a user I reconnect and nothing is lost | Both my offline edits and others' edits are present afterwards |
| U6 | As a user I reload the page | The document and my unsent edits are still there |
| U7 | As a developer I can see the algorithm working | A debug panel shows character IDs, tombstones and the operation log |

## 5. Functional requirements
- F1. Create a document and get a shareable link.
- F2. Text insertion and deletion, including pasted blocks and multi-character deletes.
- F3. Undo and redo of the local user's own edits only. (Stretch if time is short.)
- F4. Presence: name, colour, cursor and selection of each connected user.
- F5. Reconnect with automatic resync from the last known sequence number.
- F6. Server keeps a durable operation log and periodic snapshots.
- F7. Several server processes can run at once, sharing edits through Redis.

## 6. Non-functional requirements and targets
These are **targets to test against**, not results.

| Area | Target |
|---|---|
| Convergence | 100 percent on at least 10,000 random fuzz runs |
| Latency | p99 edit propagation under 100 ms with 50 clients on one machine |
| Document size | Smooth editing at 100,000 characters |
| Concurrency | 100 simulated clients on one document without divergence |
| Recovery | Server restart loses no acknowledged edit |
| Memory | Tombstone growth measured and documented, with a compaction plan |

## 7. Success metrics
- Fuzz test pass rate and number of schedules tested.
- Measured p50 and p99 propagation latency at 10, 50 and 100 clients.
- Operations per second the server sustains.
- Size of the document state versus visible text length (tombstone overhead).
- A short comparison table of own CRDT versus Yjs (speed and memory).

## 8. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Ordering rule has a subtle bug | Replicas diverge | Property tests from Day 2; keep the algorithm small |
| Operations arrive before their dependencies | Edits fail to apply | Buffer pending ops until the origin character exists |
| Editor integration is fiddly (cursor jumps) | Bad demo | Use CodeMirror 6 change objects; store cursors as character IDs |
| Tombstones grow forever | Memory and speed problems | Measure first; document compaction as a stretch |
| Scope creep into rich text | Project never ships | Non-goals list above; freeze scope at end of Week 1 |
| Time overrun | Incomplete project | Three buffer days; Week 3 items marked optional |

## 9. Open questions
- Own CRDT only, or also wrap Yjs as a second backend for comparison? (Plan: own first, Yjs comparison in Week 3.)
- Server-side snapshots: computed by a Python port of the CRDT, or uploaded by clients? (See `05-DATABASE.md`; default is client-uploaded snapshots.)
