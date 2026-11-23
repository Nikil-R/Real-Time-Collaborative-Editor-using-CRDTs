"use client";

import { useEditorStore } from "@/lib/store";

/** Make control characters visible so the table is readable. */
function show(ch: string): string {
  if (ch === "\n") return "↵";
  if (ch === " ") return "·";
  return ch;
}

/** The "see the algorithm working" panel (docs/01-PRD.md U7). */
export function DebugPanel() {
  const s = useEditorStore();
  return (
    <aside
      data-testid="debug-panel"
      className="w-80 shrink-0 overflow-y-auto border-l border-stone-200 bg-stone-50 p-3 text-xs"
    >
      <h2 className="mb-2 text-sm font-semibold">Debug panel</h2>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        <dt className="text-stone-500">Replica</dt>
        <dd className="truncate font-mono" title={s.replicaId}>{s.replicaId}</dd>
        <dt className="text-stone-500">Lamport clock</dt>
        <dd data-testid="dbg-clock" className="font-mono">{s.clock}</dd>
        <dt className="text-stone-500">Visible chars</dt>
        <dd data-testid="dbg-length" className="font-mono">{s.length}</dd>
        <dt className="text-stone-500">Nodes (with tombstones)</dt>
        <dd data-testid="dbg-nodes" className="font-mono">{s.nodes}</dd>
        <dt className="text-stone-500">Tombstones</dt>
        <dd data-testid="dbg-tombstones" className="font-mono">{s.tombstones}</dd>
        <dt className="text-stone-500">Pending ops</dt>
        <dd data-testid="dbg-pending" className="font-mono">{s.pending}</dd>
        <dt className="text-stone-500">Outbox (unsent)</dt>
        <dd className="font-mono">{s.outbox}</dd>
        <dt className="text-stone-500">last_seq / head</dt>
        <dd className="font-mono">{s.lastSeq} / {s.headSeq}</dd>
      </dl>

      <h3 className="mb-1 mt-4 font-semibold">Character list (last {s.debugNodes.length})</h3>
      <p className="mb-2 text-stone-500">
        Every character has a permanent id (clock@replica). Deleted characters stay as tombstones.
      </p>
      <ol className="font-mono">
        {s.debugNodes.map((n) => (
          <li
            key={`${n.clock}@${n.replica}`}
            className={n.deleted ? "text-stone-400 line-through" : ""}
            data-deleted={n.deleted}
          >
            <span className="inline-block w-5 text-center text-sm">{show(n.char)}</span>{" "}
            {n.clock}@{n.replica.slice(0, 8)}
            {n.deleted ? "  tombstone" : ""}
          </li>
        ))}
      </ol>
    </aside>
  );
}
