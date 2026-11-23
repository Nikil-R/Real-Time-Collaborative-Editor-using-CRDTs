"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { baseName, languageFor } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace-store";

/** Fuzzy match: every typed letter must appear in order. Returns a score, or -1. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - (found - ti) * 0.1;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

/** Ctrl+P: jump to any file by typing a few letters of its path. */
export function QuickOpen() {
  const open = useWorkspace((s) => s.quickOpen);
  const files = useWorkspace((s) => s.files);
  const openFile = useWorkspace((s) => s.openFile);
  const set = useWorkspace((s) => s.set);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        set({ quickOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(
    () =>
      files
        .map((f) => ({ f, score: fuzzyScore(query, f.name) }))
        .filter((r) => r.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12),
    [files, query],
  );

  if (!open) return null;
  const close = () => set({ quickOpen: false });
  const choose = (i: number) => {
    const r = results[i];
    if (r) openFile(r.f.id);
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
      onMouseDown={close}
      data-testid="quick-open"
    >
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Go to file"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={15} className="text-faint" />
          <input
            ref={inputRef}
            data-testid="quick-open-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, results.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              if (e.key === "Enter") choose(index);
            }}
            placeholder="Type a file name…"
            className="h-11 w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint"
          />
        </div>
        <ul className="max-h-72 overflow-y-auto py-1" role="listbox">
          {results.map(({ f }, i) => {
            const lang = languageFor(f.name);
            return (
              <li
                key={f.id}
                role="option"
                aria-selected={i === index}
                data-testid="quick-open-item"
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                  i === index ? "bg-accent-soft text-fg" : "text-muted",
                )}
              >
                <span
                  className="inline-flex h-4 min-w-[22px] items-center justify-center rounded px-1 font-mono text-[9px] font-bold"
                  style={{ color: lang.color, backgroundColor: `${lang.color}22` }}
                >
                  {lang.badge}
                </span>
                <span className="text-fg">{baseName(f.name)}</span>
                <span className="truncate text-xs text-faint">{f.name}</span>
              </li>
            );
          })}
          {results.length === 0 && <li className="px-3 py-3 text-sm text-faint">No matching files.</li>}
        </ul>
      </div>
    </div>
  );
}
