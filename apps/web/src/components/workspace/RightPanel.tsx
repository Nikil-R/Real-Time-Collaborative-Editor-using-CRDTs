"use client";

import { useEffect, useMemo, useState } from "react";
import { FilePlus2, Pencil, Trash2, X } from "lucide-react";
import { Avatar } from "./Avatar";
import type { ActivityEvent } from "@/lib/api";
import { editors } from "@/lib/editor-registry";
import { timeAgo } from "@/lib/format";
import { isMarkdown } from "@/lib/languages";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { EMPTY_STATS, useWorkspace, type RightPanel as PanelId } from "@/lib/workspace-store";

const TITLES: Record<Exclude<PanelId, null>, string> = {
  activity: "Activity",
  preview: "Preview",
  debug: "CRDT debug",
};

function describe(e: ActivityEvent): React.ReactNode {
  const file = <span className="font-medium text-fg">{e.file_name ?? "a file"}</span>;
  switch (e.kind) {
    case "edit":
      return (
        <>
          edited {file} <span className="text-faint">({e.count} change{e.count === 1 ? "" : "s"})</span>
        </>
      );
    case "file_created":
      return <>created {file}</>;
    case "file_renamed":
      return <>renamed {file}</>;
    case "file_deleted":
      return <>deleted {file}</>;
  }
}

function ActivityFeed() {
  const activity = useWorkspace((s) => s.activity);
  const files = useWorkspace((s) => s.files);
  const openFile = useWorkspace((s) => s.openFile);
  const collaborators = useWorkspace((s) => s.collaborators);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const colors = useMemo(() => new Map(collaborators.map((c) => [c.name, c.color])), [collaborators]);

  if (activity.length === 0) {
    return <p className="p-4 text-sm text-faint">Nothing yet. Edits, new files and renames show up here.</p>;
  }
  return (
    <ol className="divide-y divide-line" data-testid="activity-list">
      {activity.map((e) => {
        const target = e.file_id ? files.find((f) => f.id === e.file_id) : undefined;
        const Icon = e.kind === "file_created" ? FilePlus2 : e.kind === "file_deleted" ? Trash2 : Pencil;
        return (
          <li key={e.id} className="flex gap-2.5 px-3 py-2.5 text-[13px]" data-testid="activity-item" data-kind={e.kind}>
            <Avatar name={e.actor} color={colors.get(e.actor) ?? "#64748b"} size={22} />
            <div className="min-w-0 flex-1">
              <p className="text-muted">
                <span className="font-semibold text-fg">{e.actor}</span> {describe(e)}
              </p>
              <p className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                <Icon size={11} />
                {timeAgo(e.ts, now)}
                {target && (
                  <button className="text-accent hover:underline" onClick={() => openFile(target.id)}>
                    open
                  </button>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Preview() {
  const activeId = useWorkspace((s) => s.activeId);
  const files = useWorkspace((s) => s.files);
  // `version` changes on every edit of the file, which re-renders the preview.
  const version = useWorkspace((s) => (s.activeId ? (s.docs[s.activeId]?.version ?? 0) : 0));
  const file = files.find((f) => f.id === activeId);
  const html = useMemo(() => {
    if (!activeId || !file || !isMarkdown(file.name)) return "";
    const view = editors.get(activeId)?.view;
    return view ? renderMarkdown(view.state.doc.toString()) : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, file, version]);

  if (!file || !isMarkdown(file.name)) {
    return <p className="p-4 text-sm text-faint">Open a Markdown file to see its preview.</p>;
  }
  return (
    <div
      className="prose-preview p-4"
      data-testid="markdown-preview"
      // Safe: renderMarkdown sanitises the HTML (see lib/markdown.ts and its tests).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function show(ch: string): string {
  if (ch === "\n") return "↵";
  if (ch === " ") return "·";
  return ch;
}

function DebugView() {
  const stats = useWorkspace((s) => (s.activeId ? (s.docs[s.activeId] ?? EMPTY_STATS) : EMPTY_STATS));
  const nodes = useWorkspace((s) => s.debugNodes);
  const rows: [string, string | number, string?][] = [
    ["Replica", stats.replicaId || "–"],
    ["Lamport clock", stats.clock, "dbg-clock"],
    ["Visible chars", stats.length, "dbg-length"],
    ["Nodes (with tombstones)", stats.nodes, "dbg-nodes"],
    ["Tombstones", stats.tombstones, "dbg-tombstones"],
    ["Pending ops", stats.pending, "dbg-pending"],
    ["Unsent (outbox)", stats.outbox],
    ["last_seq / head", `${stats.lastSeq} / ${stats.headSeq}`],
  ];
  return (
    <div className="p-3 text-xs" data-testid="debug-panel">
      <p className="mb-3 text-muted">
        Every character has a permanent id (clock@replica). Deleted characters stay as tombstones so
        concurrent edits still point at something valid.
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map(([label, value, testId]) => (
          <div key={label} className="contents">
            <dt className="text-faint">{label}</dt>
            <dd className="truncate font-mono" data-testid={testId} title={String(value)}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-4 mb-1 font-semibold">Character list (last {nodes.length})</h3>
      <ol className="font-mono">
        {nodes.map((n) => (
          <li
            key={`${n.clock}@${n.replica}`}
            data-deleted={n.deleted}
            className={cn("flex items-center gap-2", n.deleted && "text-faint line-through")}
          >
            <span className="inline-block w-5 text-center text-sm">{show(n.char)}</span>
            <span>
              {n.clock}@{n.replica.slice(0, 8)}
            </span>
            {n.deleted && <span className="text-[10px] uppercase no-underline">tombstone</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RightPanel() {
  const panel = useWorkspace((s) => s.panel);
  const set = useWorkspace((s) => s.set);
  if (!panel) return null;
  return (
    <aside
      data-testid="right-panel"
      data-panel={panel}
      className="z-10 flex w-80 shrink-0 flex-col border-l border-line bg-panel max-lg:absolute max-lg:inset-y-12 max-lg:right-0 max-lg:shadow-2xl"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3 text-[11px] font-semibold tracking-wider text-faint uppercase">
        {TITLES[panel]}
        <button
          aria-label="Close panel"
          className="rounded p-1 hover:bg-raised hover:text-fg"
          onClick={() => set({ panel: null })}
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel === "activity" && <ActivityFeed />}
        {panel === "preview" && <Preview />}
        {panel === "debug" && <DebugView />}
      </div>
    </aside>
  );
}
