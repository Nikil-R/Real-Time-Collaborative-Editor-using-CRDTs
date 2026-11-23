"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FilePlus2, Folder, FolderOpen, Pencil, Trash2 } from "lucide-react";
import { Avatar } from "./Avatar";
import { ApiError, api } from "@/lib/api";
import { buildTree, type TreeNode } from "@/lib/format";
import { getColor, getName } from "@/lib/identity";
import { baseName, languageFor } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace-store";

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Is the server running?";
}

/** A one-line text field used for creating and renaming files. */
function InlineInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
  testId,
}: {
  initial: string;
  placeholder: string;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
  testId: string;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const busy = useRef(false);
  return (
    <div className="px-2 py-1">
      <input
        autoFocus
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          setError("");
        }}
        onFocus={(e) => {
          // Select the name part (not the extension) when renaming.
          const dot = initial.lastIndexOf(".");
          if (initial && dot > 0) e.currentTarget.setSelectionRange(initial.lastIndexOf("/") + 1, dot);
        }}
        onKeyDown={async (e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !busy.current) {
            busy.current = true;
            try {
              await onSubmit(value.trim());
            } catch (err) {
              setError(errorText(err));
            } finally {
              busy.current = false;
            }
          }
        }}
        onBlur={() => {
          if (!error) onCancel();
        }}
        className="w-full rounded border border-accent bg-app px-2 py-1 text-xs text-fg outline-none"
        spellCheck={false}
      />
      {error && (
        <p role="alert" data-testid="file-error" className="mt-1 text-[11px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

function FileRow({ node, depth, projectId }: { node: TreeNode; depth: number; projectId: string }) {
  const activeId = useWorkspace((s) => s.activeId);
  const collaborators = useWorkspace((s) => s.collaborators);
  const openFile = useWorkspace((s) => s.openFile);
  const status = useWorkspace((s) => (node.fileId ? s.docs[node.fileId]?.status : undefined));
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const id = node.fileId!;
  const lang = languageFor(node.name);
  const here = collaborators.filter((c) => c.file_id === id);
  const active = activeId === id;

  if (mode === "rename") {
    return (
      <InlineInput
        initial={node.path}
        placeholder="path/name.ext"
        testId="rename-input"
        onCancel={() => setMode("view")}
        onSubmit={async (name) => {
          if (name && name !== node.path) await api.renameFile(projectId, id, name);
          setMode("view");
        }}
      />
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md py-1 pr-1.5 text-[13px]",
        active ? "bg-accent-soft text-fg" : "text-muted hover:bg-raised hover:text-fg",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
      data-testid={`file-row-${node.path}`}
      data-active={active}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => openFile(id)}
        data-testid={`file-${node.path}`}
        title={node.path}
      >
        <span
          className="inline-flex h-4 min-w-[22px] items-center justify-center rounded px-1 font-mono text-[9px] font-bold"
          style={{ color: lang.color, backgroundColor: `${lang.color}22` }}
        >
          {lang.badge}
        </span>
        <span className="truncate">{node.name}</span>
        {status === "offline" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Offline" />}
      </button>
      {mode === "delete" ? (
        <span className="flex items-center gap-1 text-[11px]">
          <button
            data-testid="confirm-delete"
            className="rounded bg-bad px-1.5 py-0.5 font-semibold text-white"
            onClick={async () => {
              try {
                await api.deleteFile(projectId, id);
              } finally {
                setMode("view");
              }
            }}
          >
            Delete
          </button>
          <button className="rounded px-1.5 py-0.5 hover:bg-raised" onClick={() => setMode("view")}>
            Keep
          </button>
        </span>
      ) : (
        <>
          <span className="flex -space-x-1">
            {here.slice(0, 3).map((c) => (
              <Avatar key={c.replica} name={c.name} color={c.color} size={16} />
            ))}
          </span>
          <span className="hidden items-center group-hover:flex group-focus-within:flex">
            <button
              aria-label={`Rename ${node.name}`}
              data-testid={`rename-${node.path}`}
              className="rounded p-1 text-faint hover:bg-raised hover:text-fg"
              onClick={() => setMode("rename")}
            >
              <Pencil size={12} />
            </button>
            <button
              aria-label={`Delete ${node.name}`}
              data-testid={`delete-${node.path}`}
              className="rounded p-1 text-faint hover:bg-raised hover:text-bad"
              onClick={() => setMode("delete")}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </>
      )}
    </div>
  );
}

function Branch({
  nodes,
  depth,
  projectId,
  closed,
  toggle,
}: {
  nodes: TreeNode[];
  depth: number;
  projectId: string;
  closed: Set<string>;
  toggle: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.fileId === undefined ? (
          <div key={`d:${node.path}`}>
            <button
              className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] text-muted hover:bg-raised hover:text-fg"
              style={{ paddingLeft: 4 + depth * 14 }}
              onClick={() => toggle(node.path)}
              aria-expanded={!closed.has(node.path)}
              data-testid={`folder-${node.path}`}
            >
              {closed.has(node.path) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              {closed.has(node.path) ? <Folder size={14} /> : <FolderOpen size={14} />}
              <span className="truncate">{node.name}</span>
            </button>
            {!closed.has(node.path) && (
              <Branch
                nodes={node.children}
                depth={depth + 1}
                projectId={projectId}
                closed={closed}
                toggle={toggle}
              />
            )}
          </div>
        ) : (
          <FileRow key={`f:${node.fileId}`} node={node} depth={depth} projectId={projectId} />
        ),
      )}
    </>
  );
}

export function Sidebar() {
  const files = useWorkspace((s) => s.files);
  const projectId = useWorkspace((s) => s.projectId);
  const collaborators = useWorkspace((s) => s.collaborators);
  const openFile = useWorkspace((s) => s.openFile);
  const sidebarOpen = useWorkspace((s) => s.sidebarOpen);
  const [creating, setCreating] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);
  const me = getName();

  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        "z-20 flex w-64 shrink-0 flex-col border-r border-line bg-panel",
        "max-md:absolute max-md:inset-y-12 max-md:left-0 max-md:shadow-2xl",
        !sidebarOpen && "max-md:hidden",
      )}
    >
      <div className="flex h-9 items-center justify-between px-3 text-[11px] font-semibold tracking-wider text-faint uppercase">
        Explorer
        <button
          onClick={() => setCreating(true)}
          className="rounded p-1 text-muted hover:bg-raised hover:text-fg"
          aria-label="New file"
          data-testid="new-file"
        >
          <FilePlus2 size={15} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label="Files">
        {creating && (
          <InlineInput
            initial=""
            placeholder="src/new-file.ts"
            testId="new-file-input"
            onCancel={() => setCreating(false)}
            onSubmit={async (name) => {
              if (!name) return setCreating(false);
              const created = await api.createFile(projectId, name);
              setCreating(false);
              openFile(created.id);
            }}
          />
        )}
        <Branch nodes={tree} depth={0} projectId={projectId} closed={closed} toggle={toggle} />
        {files.length === 0 && !creating && (
          <p className="px-3 py-4 text-xs text-faint">No files yet. Create one with the + button.</p>
        )}
      </nav>

      <div className="border-t border-line px-3 py-2">
        <h2 className="mb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">
          People ({collaborators.length + 1})
        </h2>
        <ul className="space-y-1" data-testid="people-list">
          <li className="flex items-center gap-2 text-[13px]">
            <Avatar name={me} color={getColor()} size={20} />
            <span className="truncate">{me}</span>
            <span className="text-[10px] text-faint">you</span>
          </li>
          {collaborators.map((c) => {
            const file = files.find((f) => f.id === c.file_id);
            return (
              <li key={c.replica} className="flex items-center gap-2 text-[13px]" data-testid="person">
                <Avatar name={c.name} color={c.color} size={20} />
                <span className="truncate">{c.name}</span>
                {file && (
                  <button
                    onClick={() => openFile(file.id)}
                    className="ml-auto truncate text-[11px] text-faint hover:text-accent"
                    title={`Open ${file.name}`}
                    data-testid="person-file"
                  >
                    {baseName(file.name)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
