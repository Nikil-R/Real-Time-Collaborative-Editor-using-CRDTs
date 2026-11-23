"use client";

import { X } from "lucide-react";
import { baseName, languageFor } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace-store";

export function TabBar() {
  const files = useWorkspace((s) => s.files);
  const openIds = useWorkspace((s) => s.openIds);
  const activeId = useWorkspace((s) => s.activeId);
  const docs = useWorkspace((s) => s.docs);
  const setActive = useWorkspace((s) => s.setActive);
  const closeFile = useWorkspace((s) => s.closeFile);

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel2"
    >
      {openIds.map((id) => {
        const file = files.find((f) => f.id === id);
        if (!file) return null;
        const lang = languageFor(file.name);
        const active = id === activeId;
        const stats = docs[id];
        const unsent = (stats?.outbox ?? 0) > 0 || stats?.status === "offline";
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            data-testid={`tab-${file.name}`}
            data-active={active}
            className={cn(
              "group relative flex shrink-0 cursor-pointer items-center gap-2 border-r border-line px-3 text-[13px]",
              active ? "bg-panel text-fg" : "text-muted hover:bg-panel hover:text-fg",
            )}
            onClick={() => setActive(id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeFile(id);
            }}
          >
            {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
            <span
              className="inline-flex h-4 min-w-[22px] items-center justify-center rounded px-1 font-mono text-[9px] font-bold"
              style={{ color: lang.color, backgroundColor: `${lang.color}22` }}
            >
              {lang.badge}
            </span>
            <span title={file.name}>{baseName(file.name)}</span>
            {unsent && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-warn"
                title="Changes not yet sent to the server"
                data-testid="tab-unsent"
              />
            )}
            <button
              aria-label={`Close ${file.name}`}
              data-testid={`close-${file.name}`}
              className="rounded p-0.5 text-faint opacity-60 hover:bg-raised hover:text-fg hover:opacity-100 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
