"use client";

import { Activity, Bug, Eye, Wifi, WifiOff } from "lucide-react";
import { setAllOffline } from "@/lib/editor-registry";
import { isMarkdown, languageFor } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { EMPTY_STATS, useWorkspace, type RightPanel } from "@/lib/workspace-store";

const STATUS_LABEL: Record<string, string> = {
  loading: "Loading…",
  connecting: "Connecting…",
  online: "Online",
  offline: "Offline: changes saved locally",
  closed: "Disconnected",
};

export function StatusBar() {
  const activeId = useWorkspace((s) => s.activeId);
  const files = useWorkspace((s) => s.files);
  const stats = useWorkspace((s) => (s.activeId ? (s.docs[s.activeId] ?? EMPTY_STATS) : EMPTY_STATS));
  const channel = useWorkspace((s) => s.channel);
  const forcedOffline = useWorkspace((s) => s.forcedOffline);
  const panel = useWorkspace((s) => s.panel);
  const set = useWorkspace((s) => s.set);
  const file = files.find((f) => f.id === activeId);

  // The editor's own connection is what matters while a file is open.
  const status = file ? stats.status : channel === "online" ? "online" : channel;
  const online = status === "online";
  const unsent = Object.values(useWorkspace((s) => s.docs)).reduce((n, d) => n + d.outbox, 0);

  const toggleOffline = () => {
    const next = !forcedOffline;
    set({ forcedOffline: next });
    setAllOffline(next);
    window.dispatchEvent(new CustomEvent("rce:offline", { detail: next }));
  };
  const toggle = (p: RightPanel) => set({ panel: panel === p ? null : p });

  const PanelButton = ({ id, icon, label }: { id: RightPanel; icon: React.ReactNode; label: string }) => (
    <button
      onClick={() => toggle(id)}
      data-testid={`panel-${id}`}
      aria-pressed={panel === id}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 hover:bg-white/15",
        panel === id && "bg-white/20",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 bg-accent px-3 text-[12px] text-white">
      <span
        data-testid="status"
        data-status={status}
        className="inline-flex items-center gap-1.5 font-medium"
      >
        {online ? <Wifi size={13} /> : <WifiOff size={13} />}
        {STATUS_LABEL[status] ?? status}
      </span>
      <button
        onClick={toggleOffline}
        data-testid="toggle-offline"
        className="rounded bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25"
      >
        {forcedOffline ? "Go online" : "Simulate offline"}
      </button>
      {unsent > 0 && (
        <span data-testid="outbox" className="opacity-90">
          {unsent} unsent
        </span>
      )}
      {stats.detail && <span className="text-yellow-100">{stats.detail}</span>}

      <span className="ml-auto flex items-center gap-1">
        {file && (
          <>
            <span data-testid="cursor-pos" className="mr-2 opacity-90">
              Ln {stats.line}, Col {stats.col}
            </span>
            <span data-testid="language" className="mr-2 opacity-90">
              {languageFor(file.name).label}
            </span>
          </>
        )}
        <PanelButton id="activity" icon={<Activity size={13} />} label="Activity" />
        {file && isMarkdown(file.name) && (
          <PanelButton id="preview" icon={<Eye size={13} />} label="Preview" />
        )}
        <PanelButton id="debug" icon={<Bug size={13} />} label="Debug" />
      </span>
    </footer>
  );
}
