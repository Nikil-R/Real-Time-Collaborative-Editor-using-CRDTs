"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Link2, Moon, PanelLeft, Search, Sun } from "lucide-react";
import { Avatar } from "./Avatar";
import { getColor, getName } from "@/lib/identity";
import { useWorkspace } from "@/lib/workspace-store";

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg font-mono font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: "linear-gradient(135deg, #8b6cff, #22d3ee)",
      }}
      aria-hidden
    >
      {"{}"}
    </span>
  );
}

export function TopBar() {
  const projectName = useWorkspace((s) => s.projectName);
  const collaborators = useWorkspace((s) => s.collaborators);
  const theme = useWorkspace((s) => s.theme);
  const set = useWorkspace((s) => s.set);
  const [copied, setCopied] = useState(false);
  const me = getName();

  const copy = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("rce:theme", next);
    set({ theme: next });
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <button
        className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg md:hidden"
        aria-label="Toggle explorer"
        onClick={() => set({ sidebarOpen: !useWorkspace.getState().sidebarOpen })}
      >
        <PanelLeft size={18} />
      </button>
      <Link href="/" className="flex items-center gap-2" aria-label="Home">
        <LogoMark />
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">CRDT Workspace</span>
      </Link>
      <span className="text-faint">/</span>
      <span data-testid="project-name" className="max-w-[40vw] truncate text-sm text-muted">
        {projectName || "Loading…"}
      </span>

      <button
        onClick={() => set({ quickOpen: true })}
        className="ml-4 hidden items-center gap-2 rounded-md border border-line bg-panel2 px-3 py-1 text-xs text-muted hover:border-accent hover:text-fg lg:flex"
        data-testid="open-quick"
      >
        <Search size={13} /> Go to file
        <kbd className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px]">Ctrl P</kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        <ul className="flex items-center -space-x-1.5" aria-label="People in this workspace">
          <li>
            <Avatar name={me} color={getColor()} title={`${me} (you)`} />
          </li>
          {collaborators.map((c) => (
            <li key={c.replica} data-testid="peer">
              <Avatar name={c.name} color={c.color} />
            </li>
          ))}
        </ul>
        <button
          onClick={toggleTheme}
          className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          data-testid="toggle-theme"
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          data-testid="share"
        >
          {copied ? <Check size={14} /> : <Link2 size={14} />}
          {copied ? "Link copied" : "Share"}
        </button>
      </div>
    </header>
  );
}
