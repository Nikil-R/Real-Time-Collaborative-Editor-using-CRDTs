"use client";

import { useState } from "react";
import Link from "next/link";
import { Bug, Check, Link2, WifiOff, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sessionRef } from "@/lib/session-registry";
import { useEditorStore } from "@/lib/store";

const STATUS_LABEL: Record<string, string> = {
  loading: "Loading…",
  connecting: "Connecting…",
  online: "Online",
  offline: "Offline: changes saved locally",
  closed: "Disconnected",
};

export function DocHeader({ docId }: { docId: string }) {
  const { status, detail, peers, outbox, forcedOffline, debugOpen, patch } = useEditorStore();
  const [copied, setCopied] = useState(false);

  const online = status === "online";
  const toggleOffline = () => {
    const next = !forcedOffline;
    patch({ forcedOffline: next });
    sessionRef.current?.setOfflineMode(next);
  };
  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-2">
      <Link href="/" className="text-sm font-semibold text-stone-800 hover:underline">
        CRDT Editor
      </Link>
      <span className="font-mono text-xs text-stone-400" title={docId}>
        {docId.slice(0, 8)}
      </span>

      <span
        data-testid="status"
        data-status={status}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
          online && "bg-emerald-100 text-emerald-800",
          (status === "offline" || status === "connecting" || status === "loading") &&
            "bg-amber-100 text-amber-800",
          status === "closed" && "bg-red-100 text-red-800",
        )}
      >
        {online ? <Wifi size={12} /> : <WifiOff size={12} />}
        {STATUS_LABEL[status] ?? status}
      </span>
      {detail && <span className="text-xs text-red-700">{detail}</span>}
      {outbox > 0 && (
        <span data-testid="outbox" className="text-xs text-stone-500">
          {outbox} unsent
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <ul className="flex -space-x-1.5" aria-label="People in this document">
          {peers.map((p) => (
            <li
              key={p.replica}
              title={p.name}
              data-testid="peer"
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white"
              style={{ backgroundColor: p.color }}
            >
              {/* text node, never innerHTML: a hostile display name stays text */}
              {Array.from(p.name)[0]?.toUpperCase() ?? "?"}
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" onClick={toggleOffline} data-testid="toggle-offline">
          {forcedOffline ? "Go online" : "Simulate offline"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => patch({ debugOpen: !debugOpen })}
          data-testid="toggle-debug"
        >
          <Bug size={14} /> Debug
        </Button>
        <Button size="sm" onClick={copyLink}>
          {copied ? <Check size={14} /> : <Link2 size={14} />} {copied ? "Copied" : "Share"}
        </Button>
      </div>
    </header>
  );
}
