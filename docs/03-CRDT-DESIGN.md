# 03 - CRDT Design (RGA)

This is the most important document in the project. Read it twice before writing code.

## 1. The goal in one sentence
Any set of replicas that have received the **same set of operations**, in **any order** and with **any duplicates**, must show **identical text**. This property is called **strong eventual consistency**.

## 2. Vocabulary
- **Replica:** one copy of the document (one browser tab, or one simulated user).
- **Operation (op):** a description of one change, sent to other replicas.
- **Lamport clock:** a counter that only goes up. When a replica sees a larger clock from someone else, it jumps ahead of it, so new IDs are always larger than everything the replica has seen.
- **Tombstone:** a deleted character that stays in the data structure but is hidden from the text.

## 3. Identifiers
Every character gets a permanent ID:

```
CharId = (clock: number, replica: string)
```

Comparison order (used for tie-breaking):
1. Higher `clock` is greater.
2. If clocks are equal, higher `replica` string is greater (compare as plain strings).

Every replica keeps a `clock` counter. Creating a character does `clock = clock + 1` and uses that value. When applying a remote op, set `clock = max(clock, op.id.clock)`.

The special ID `ROOT = (0, "")` stands for the start of the document.

## 4. Data structure
A single ordered sequence of nodes, plus an index:

```
Node {
  id: CharId
  char: string         // one character (single UTF-16 code unit, see section 10)
  deleted: boolean     // tombstone flag
}

Replica {
  replicaId: string
  clock: number
  nodes: Node[]                  // the sequence, ROOT is implicit at index -1
  index: Map<idKey, Node>        // idKey = clock + "@" + replica
  pendingInserts: Map<originKey, InsertOp[]>   // ops waiting for their origin
  pendingDeletes: Map<targetKey, DeleteOp[]>   // ops waiting for their target
  seen: Set<idKey>               // applied insert ids (for idempotence)
}
```

First version uses an array. Finding the visible index of a node means counting non-deleted nodes before it, which is O(n). That is acceptable for a first version and was measured (see `docs/results/`).

**Implementation note (changed after measuring).** The first draft stored `index: Map<idKey, position>`. Every insert shifted all later positions, so the map had to be rebuilt from the insertion point on (creating a string key per node), which dominated the cost of random inserts. The map now stores the `Node` object and a position is found with `nodes.indexOf(node)`, starting from a self-validating hint (the position of the node inserted last, which makes chains such as a paste or a typed word O(1) per character). The pending buffer is two maps keyed by the missing dependency, so releasing waiting ops is O(1) instead of scanning a list.

## 5. Operations

```
InsertOp { type: "ins", id: CharId, origin: CharId, char: string }
DeleteOp { type: "del", target: CharId, opId: OpId }
```

- `origin` is the ID of the character this one was inserted **directly after**, at the moment of typing. For the start of the document it is `ROOT`.
- Deletes refer to the character's ID, never to a position.
- For idempotence of deletes, the operation also carries a unique `opId = (replica, counter)` used for the server's de-duplication. Applying a delete twice is harmless anyway because setting `deleted = true` twice changes nothing.

## 6. Local operations (user types)

**Local insert at visible index `i` of character `c`:**
1. Find `origin`: the node just before visible position `i` (or `ROOT` if `i = 0`). Use the visible character, skipping tombstones.
2. `clock = clock + 1`; `id = (clock, replicaId)`.
3. Run the integration step (section 7) with `{id, origin, c}`.
4. Emit the `InsertOp` to the network.

**Local delete of visible range `[i, i+n)`:**
1. For each visible node in the range, set `deleted = true`.
2. Emit one `DeleteOp` per character (batch them in one message).

Multi-character paste = a series of inserts, each with `origin` equal to the previous inserted character. Send as one batch.

## 7. Integration: inserting a remote insert

This is the ordering rule. It is the heart of RGA.

```
integrate(op):
  if op.id already in seen: return                  // idempotent
  if op.origin != ROOT and op.origin not in index:  // dependency missing
      pending.add(op); return
  pos = position of op.origin in nodes (or -1 for ROOT)
  pos = pos + 1                                     // first slot after origin
  // skip over nodes that must stay to the left of the new one
  while pos < nodes.length and nodes[pos].id > op.id:
      pos = pos + 1
  insert Node(op.id, op.char, deleted=false) at nodes[pos]
  seen.add(op.id)
  clock = max(clock, op.id.clock)
  retry any pending ops whose origin is now present
```

**In words:** start right after the origin. Move right past any node with a **larger ID** than the new node. Insert there. Nodes with larger IDs were created "later" (by Lamport order), so they sit closer to the origin.

### Why skipping works
If a node X right after the origin has a larger ID than the new node N, then X was created after the replica that created N had seen the same state, or concurrently with a higher tie-break. Either way, X and everything that depends on X (its descendants, which also have larger IDs than X's origin chain) must stay before N so that every replica produces the same order. Descendants of X have IDs larger than X, so they also have IDs larger than N, so the loop skips them too, keeping X's whole subtree together.

## 8. Applying a remote delete
```
applyDelete(op):
  if op.target not in index: pending.add(op); return
  nodes[index[op.target]].deleted = true
```
Delete operations never reorder anything, so they commute with everything.

## 9. Dry run (matches the plain-English example)

Start: `C(1@a)  A(2@a)  T(3@a)`, all replicas agree. Clocks are all at least 3.

- Priya (replica `p`) types R after A: `id = (4, p)`, `origin = (2,a)`.
- Rahul (replica `r`) types S after A at the same time: `id = (4, r)`, `origin = (2,a)`.

On Priya's replica: R is already after A. Apply Rahul's S:
- The loop condition is `nodes[pos].id > op.id`. Here `nodes[pos]` is R with id `(4,p)` and `op.id` is `(4,r)`.
- Is `(4,p) > (4,r)`? Clocks are equal, and `p < r` as strings, so no. The loop stops immediately and S is inserted **before** R.
- Result: `C A S R T`.

On Rahul's replica: S is already after A. Apply Priya's R: `nodes[pos]` is S with id `(4,r)`, `op.id = (4,p)`. Is `(4,r) > (4,p)`? Yes, so skip S. Next node is T, whose id `(3,a)` is not greater than `(4,p)`, stop. Insert R after S.
- Result: `C A S R T`.

Both replicas now show **CASRT**. They agree. (The exact string is decided by the tie-break rule, not by user intent. That is acceptable: CRDTs guarantee agreement, not mind-reading.)

Delete T on Rahul's replica: T gets `deleted = true`. Visible text becomes `CASR` on every replica once the delete arrives.

## 10. Text encoding decisions
- First version stores one node per **UTF-16 code unit**, matching JavaScript string indexes and CodeMirror positions.
- Emoji and other characters outside the basic plane are two code units. Splitting them would corrupt text, so treat a surrogate pair as **one** node whose `char` has length 2.
- Normalise line endings to `\n`.

## 11. Causal delivery and the pending buffer
Network order is arbitrary. An insert can arrive before the insert it depends on.
- Inserts depend on their `origin`.
- Deletes depend on their `target`.
- Rule: if the dependency is missing, park the op in `pendingInserts` (keyed by origin) or `pendingDeletes` (keyed by target). After each successful integration of node X, take the ops parked under X's id and apply them (which may release more), until nothing is waiting on a node that exists. Parked ops are de-duplicated (inserts by id, deletes by `opId`).
- A pending op that never resolves means a bug or a lost message. Surface the pending count in the debug panel and in metrics.

## 12. Correctness argument (sketch)
1. **Idempotence:** applying the same op twice has no effect (the `seen` set and the delete flag guarantee it).
2. **Commutativity of concurrent ops:** the position chosen for an insert depends only on the origin and the IDs of nodes around it, not on the arrival order of unrelated ops. The skip rule yields the same relative order of any two nodes that share an origin.
3. **Delete commutes with insert:** deletes only set a flag.
4. **Causal readiness:** the pending buffer ensures an op is only applied when its dependency exists.

Together these give convergence. The **property-based tests** in `07-TESTING.md` check this empirically with thousands of random schedules. Treat the sketch as a guide, not a formal proof.

## 13. Known limitations
- **Interleaving:** when two users type whole words at the same spot concurrently, RGA can interleave characters at word boundaries in some patterns (a known weakness of simple sequence CRDTs). Document what you observe.
- **Tombstones are never removed** in the first version. Memory grows with the number of deletes. Measure it in Week 3.
- **Position lookup is O(n)** in the array version (visible offsets are a linear scan; `docs/results/` has measurements).
- **No rich text** (formatting needs extra rules).

## 14. Planned optimisations (only after measuring)
1. Keep a visible-character counter per block of nodes (chunked list) so index lookup is O(sqrt n).
2. Replace the array with a balanced tree or skip list with subtree counts for O(log n).
3. Run-length encode runs of consecutive characters from one replica (the main idea behind fast libraries such as Yjs).
4. Tombstone garbage collection once all replicas have acknowledged a delete (needs a stable-version vector from the server).
5. Binary encoding of operations.

## 15. Public API (target)

```ts
class Replica {
  constructor(replicaId: string)
  localInsert(index: number, text: string): Op[]
  localDelete(index: number, length: number): Op[]
  applyRemote(ops: Op[]): Change[]     // returns visible-text changes for the editor
  getText(): string
  indexOfId(id: CharId): number        // for cursors
  idAtIndex(index: number): CharId     // for cursors
  getState(): SerializedState
  static fromState(state: SerializedState, replicaId: string): Replica
}
```

`Change` is `{ from: number, to: number, insert: string }` in visible-text coordinates, so the editor can apply it directly.
