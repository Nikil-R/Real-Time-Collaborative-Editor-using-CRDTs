# 07 - Testing Strategy

The project's credibility rests on tests that prove convergence. Demos are not proof.

## 0. What exists today (counts from the last local run)
- `packages/crdt`: 62 Vitest tests, including 6 property tests over random multi-replica schedules (`pnpm test:crdt`; `FC_RUNS` sets the schedules per property, `pnpm test:crdt:full` uses 10,000).
- `packages/client`: 29 tests against an in-memory fake server, including 8 seeded chaos runs.
- `apps/web`: 10 unit tests (editor binding, IndexedDB store) and 9 Playwright tests.
- `server`: 37 pytest tests (repository, protocol, relay, fan-out, compaction) on SQLite and fakeredis.
- `loadtest`: 3 unit tests for the statistics, plus the load and chaos runner.

## 1. Test layers

| Layer | Tooling | Purpose |
|---|---|---|
| Unit (CRDT) | Vitest | Specific behaviours and edge cases |
| Property-based (CRDT) | fast-check | Convergence under random schedules |
| Server unit and integration | pytest, httpx, websockets | Protocol, de-duplication, storage |
| End-to-end | Playwright | Two browsers editing, offline flow |
| Load | custom Node script | Latency, throughput, divergence under many clients |
| Chaos | same script with fault injection | Drops, delays, duplicates, reorders, restarts |

## 2. CRDT unit tests (Days 1-3)
- Empty document: text is empty, insert at 0 works.
- Insert at start, middle and end.
- Delete first, last, middle, range, and everything.
- Insert after a deleted character (origin is a tombstone).
- Paste of many characters.
- Surrogate pairs (emoji) are never split.
- Two replicas, same origin, both orders of arrival give the same text.
- Three replicas, same origin.
- Operation arrives before its origin: buffered, then applied.
- Duplicate insert and duplicate delete: no change.
- Delete arrives before the insert it targets.
- Lamport clock jumps forward after seeing a larger remote clock.

## 3. Property-based tests (Day 4, the key proof)

### 3.1 Simulator
```
replicas = N (2 to 6)
steps = random sequence of:
  - local edit on replica i (insert random text at random index, or delete random range)
  - deliver one pending op from replica i to replica j (random order, random delay)
  - duplicate a pending op
at the end: deliver every op to every replica
assert: all replicas' text are equal
```

### 3.2 Properties to check
1. **Convergence:** all replicas show identical text after all ops are delivered.
2. **Order independence:** the same set of ops applied in two different random orders gives identical text.
3. **Idempotence:** re-applying every op again does not change the text.
4. **Intention (local):** immediately after a local insert at index `i`, the text equals the previous text with the new characters at `i`.
5. **Deletion respected:** a character deleted somewhere never appears in the final text.
6. **No lost characters:** every inserted and not-deleted character appears exactly once.
7. **Serialisation round trip:** `fromState(getState())` has the same text and behaves identically for later ops.
8. **Cursor stability:** an ID's index only changes by the number of visible characters inserted or deleted before it.

### 3.3 Settings
- Run at least 10,000 schedules in CI, with a fixed seed list plus random seeds.
- When a property fails, fast-check prints the seed and shrunk counterexample. Save it as a regression test.

## 4. Server tests (Days 8-10)
- Schema migration applies cleanly to an empty database.
- `hello` returns `welcome` with correct `head_seq`.
- Batch with new ops: stored, `seq` increasing, `ack` returned.
- Same batch sent twice: second time stores nothing new but still acks.
- Two clients writing to one document concurrently: no duplicate `seq`.
- Oversized message: error code `TOO_LARGE`; connection stays usable.
- Malformed JSON: `BAD_MESSAGE`; no crash.
- Catch-up paging returns all ops in order.
- Server restart mid-batch: either all of the batch is stored or none.

## 5. End-to-end tests (Days 12-15, Playwright)
1. Two pages open one document; typing in one appears in the other.
2. Simultaneous typing at the same spot: both pages show identical text.
3. Page A goes offline (network emulation), types; page B types; A reconnects; texts equal and contain both edits.
4. Reload during typing: text and unsent edits are preserved.
5. Cursor of the other user appears on the right character and survives remote edits before it.

## 6. Load tests (Day 19)

### Scenario
- 10, 50 and 100 simulated clients on one document.
- Each types at about 5 characters per second with random positions for 2 minutes.
- Clients timestamp each operation when created; receiving clients compute `receive_time - create_time`.

### Measurements
- p50, p95, p99 propagation latency.
- Server operations per second, CPU, memory.
- Postgres write latency per batch.
- Final check: all replicas equal. Any divergence fails the run.
- Document state size versus visible text length.

### Reporting rules
- Write results to `docs/results/<date>-load.md` including machine specs, versions and the exact command.
- Run each scenario at least 3 times and report the range.
- Never write a number in the README that is not in a results file.

## 7. Chaos tests (Day 19)
Fault injector wraps each simulated client's socket and randomly:
- drops the connection for 1 to 10 seconds,
- delays messages by up to 2 seconds,
- duplicates messages,
- reorders messages within a window,
- restarts the server once mid-run.

Pass condition: after faults stop and everyone reconnects, **all replicas converge** and no acknowledged operation is missing from the database.

## 8. Yjs comparison (Day 20)
- Use a real edit trace if available (for example the public "automerge-perf" editing trace, check licence), or generate a synthetic trace with fixed seed.
- Compare: apply time, peak memory, encoded size, resulting text equality.
- Report both numbers without spin. Being slower than Yjs is an expected, honest result.

## 9. CI
- `.github/workflows/ci.yml`: typecheck, unit and property tests (2,000 schedules per property on push), client tests, web unit tests and build, server lint and tests on SQLite, then again against PostgreSQL and Redis service containers (`TEST_DATABASE_URL`, `TEST_REDIS_URL`), Playwright, and a Docker build.
- Nightly (cron): the CRDT suite with 100,000 schedules per property, and a 20-client load run plus a chaos run.
- The workflow has not been executed yet (the repository had no remote CI run at the time of writing); the same commands were run locally except the PostgreSQL/Redis server tests and the Docker build.

## 10. Test data hygiene
- Seeds are logged on every failure.
- Test documents use random UUIDs and are deleted afterwards.
- No real user text in tests.
