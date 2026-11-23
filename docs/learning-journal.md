# Learning journal

Things this project taught that a tutorial would not have. Each entry says what went wrong
or surprised me, what I did, and where it is recorded.

## 1. The ordering rule is small; everything around it is where bugs hide
The RGA integrate step is about ten lines. Property tests with 2 to 6 replicas, random
delivery order, duplicates and delays (`packages/crdt/test/convergence.property.test.ts`)
exist to prove it, and a deliberate mutation (ignoring the replica tie-break) makes them fail
immediately. The real bugs were never in the ordering rule.

## 2. A "highest seq seen" watermark silently loses operations
First design: the client reconnects with `last_seq` = highest seq it received. But two
batches can commit as seq 5-6 and 7-8 and still be queued for broadcast in the opposite
order. A client that saw 7-8, then dropped, would reconnect with `last_seq=8` and never get
5-6. Fix: seq numbers are gap-free (the server gives back reserved numbers for duplicates
inside the same transaction) and the client keeps a contiguous watermark (`SeqTracker`);
a hole triggers `sync`. See `docs/05-DATABASE.md` section 3.

## 3. The sender never receives its own operations
With that watermark, a user typing alone never advanced it, so snapshots never uploaded and
reconnects re-downloaded the whole document. Fix: the `ack` lists the seqs assigned to the
batch (`seqs`). Found by a client test that expected a snapshot after typing.

## 4. A lost tail broadcast is invisible without help
If the last broadcast is lost and nothing newer arrives, there is no hole to notice. Chaos
tests (random loss, duplication, reordering of broadcasts) showed clients stuck one op
behind. Fix: `pong` carries the document's `head_seq`; a client behind it sends `sync`.

## 5. One replica id per browser profile is wrong
Two tabs on the same document would share an id and create different characters with the
same character id, which breaks convergence. The id has to belong to exactly one live
editor. Solution: a Web Lock per (document, slot) and a stable id per slot in
`localStorage`, so a reload still finds its IndexedDB outbox. The server also refuses a
second live connection with the same replica (`REPLICA_IN_USE`).

## 6. Optimising by measuring, and what noisy benchmarks do
The first benchmark showed random inserts growing quadratically, mostly from rebuilding a
position map on every insert. Storing node references instead was about 87x faster for random
inserts on a quiet machine, but the first version made a 100,000-character paste 7x slower
until a self-validating position hint fixed it. On this laptop the same code varied up to
20x between runs, so only conclusions that held in every run are written down
(`docs/results/2026-11-23-crdt-optimisation.md`).

## 7. A test that cannot fail proves nothing
Before trusting a green property suite I broke the ordering rule on purpose. The first
mutation was too crude (it broke local typing too), the second one (ignore the replica
tie-break) failed exactly the convergence properties it should have.

## 8. Tests that did not match reality
Several failures were my tests, not the code: a Playwright selector that also matched
Next.js's own route announcer, DOM sibling lookups that ignored CodeMirror's widget
buffers, a pytest helper named `test_*` that got collected as a test. Reading the real
failure output first saved time.

## What I would do next
Run-length encoding and a tree or chunked index for the CRDT (the Yjs comparison shows the
size and growth gap), tombstone garbage collection, real PostgreSQL and Redis runs of the
server tests (written but not run here), and a recorded demo GIF.
