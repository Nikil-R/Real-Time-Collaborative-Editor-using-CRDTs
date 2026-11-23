/**
 * One replica id per live editor (docs/04-PROTOCOL.md section 6).
 *
 * Two editors sharing an id would create different characters with the same
 * id and diverge. Each (document, slot) pair has a stable id kept in
 * localStorage, and a Web Lock makes sure only one tab holds a slot at a time.
 * A reload gets the same slot back (so the IndexedDB outbox is found again);
 * a second tab on the same document gets the next free slot.
 */
export interface ReplicaLease {
  replicaId: string;
  slot: number;
  release(): void;
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "r-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function acquireReplica(docId: string): Promise<ReplicaLease> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) {
    // No Web Locks: a fresh id per page load is always safe (no outbox reuse).
    return { replicaId: randomId(), slot: -1, release() {} };
  }
  for (let slot = 0; slot < 32; slot++) {
    let release: () => void = () => {};
    const acquired = await new Promise<boolean>((resolve) => {
      void locks.request(`rce-${docId}-${slot}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        // Hold the lock until release() is called (or the tab goes away).
        return new Promise<void>((done) => {
          release = done;
        });
      });
    });
    if (!acquired) continue;
    const key = `rce:replica:${docId}:${slot}`;
    let replicaId = localStorage.getItem(key);
    if (!replicaId) {
      replicaId = randomId();
      localStorage.setItem(key, replicaId);
    }
    return { replicaId, slot, release };
  }
  throw new Error("too many editors open on this document");
}
