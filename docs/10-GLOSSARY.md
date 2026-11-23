# 10 - Glossary (plain English)

**CRDT (Conflict-free Replicated Data Type):** A data structure designed so that copies on different devices can be edited independently and always merge to the same result, with no conflicts to resolve.

**Replica:** One copy of the document, for example one browser tab.

**Operation (op):** A small message that describes one change, such as "insert R after character 2@a" or "delete character 3@a".

**Eventual consistency:** If everyone stops editing and all messages are delivered, every copy ends up the same.

**Strong eventual consistency:** Any two copies that have received the same set of operations are already identical, regardless of the order they arrived in.

**Convergence:** Another word for "all copies end up the same".

**Commutative:** Order does not matter. `a then b` gives the same result as `b then a`.

**Idempotent:** Doing it twice has the same effect as doing it once.

**Causal dependency:** One operation needs another to exist first. An insert after character X depends on X having been inserted.

**Lamport clock:** A counter that increases with each local event and jumps forward when a larger counter is seen from someone else. It gives IDs that respect "happened before".

**Character ID:** A permanent label for one character, made of a clock value and a replica name. Never reused, never changed.

**Origin:** The ID of the character that a new character was inserted directly after.

**Tie-break rule:** What to do when two characters want the same spot. Here: compare IDs, larger IDs sit closer to the origin.

**Tombstone:** A deleted character kept in the structure but hidden from the visible text, so references to it still work.

**RGA (Replicated Growable Array):** The CRDT algorithm used here. A list where every element knows which element it was inserted after.

**Pending buffer:** A waiting area for operations that arrived before the operation they depend on.

**Operation log:** The server's append-only list of every operation, in the order it stored them.

**Sequence number (seq):** A per-document counter assigned by the server to each stored operation. Used only so that clients can ask "send me everything after number N".

**Snapshot:** A saved copy of the whole document state at a particular seq, so new clients do not have to replay the entire log.

**Compaction:** Removing old log entries that a snapshot already covers.

**Outbox:** The client's local queue of operations that the server has not yet acknowledged. Survives page reloads and offline periods.

**Presence:** Information about who is in the document and where their cursor is.

**Fan-out:** Sending one message to many receivers. Redis pub/sub is used to fan out between server processes.

**WebSocket:** A long-lived two-way connection between browser and server, used for real-time messages.

**Back-pressure:** What the server does when a client cannot keep up with incoming messages (drop the client and let it resync).

**Property-based testing:** Instead of writing specific examples, state a rule that must always hold (for example "all replicas converge") and let the tool generate thousands of random cases to try to break it.

**Fuzzing:** Feeding random or hostile input to find bugs.

**Chaos testing:** Deliberately injecting failures (drops, delays, restarts) to check the system recovers.

**Operational Transform (OT):** The older approach to collaborative editing, used by early Google Docs. A central server rewrites operations so they fit together. Harder to get right than CRDTs and needs a central authority.

**Yjs:** A popular, highly optimised CRDT library for JavaScript. Used here only to compare against.

**Interleaving:** A weakness where two people typing words at the same place can end up with their letters mixed together.

**p50 / p95 / p99 latency:** The time that 50, 95 or 99 percent of requests finish within. p99 shows the slow tail.

**Outbox:** The list of operations a client has created but the server has not yet acknowledged. It is saved in the browser (IndexedDB) before sending, so offline typing survives a reload.

**Watermark (contiguous seq):** The largest sequence number `S` such that the client has received every operation numbered 1 to `S`. It is the only safe value to send as `last_seq` when reconnecting, because broadcasts can arrive out of order.

**Gap-free seq:** The server numbers stored operations 1, 2, 3 with no skipped numbers, so a client can tell that it missed something by spotting a hole.

**Snapshot:** A saved copy of the whole CRDT state at some sequence number, uploaded by a client. A new client loads it instead of replaying the whole log.

**Compaction:** Deleting old operations that a snapshot already covers (keeping a safety window of recent ones).

**Replica id:** The identity of one live editor, part of every character id. Two live editors must never share one.
