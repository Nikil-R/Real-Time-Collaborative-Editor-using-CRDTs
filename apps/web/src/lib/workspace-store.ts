import { create } from "zustand";
import type { Peer, Status } from "@rce/client";
import type { ActivityEvent, FileInfo } from "./api";

/** Per-file editor state mirrored from its sync session. */
export interface DocStats {
  status: Status;
  detail: string;
  outbox: number;
  lastSeq: number;
  headSeq: number;
  length: number;
  nodes: number;
  tombstones: number;
  pending: number;
  clock: number;
  replicaId: string;
  line: number;
  col: number;
  peers: Peer[];
  /** Bumped on every change; lets the Markdown preview re-render. */
  version: number;
}

export interface DebugNode {
  clock: number;
  replica: string;
  char: string;
  deleted: boolean;
}

/** A person in the project, and the file they currently have open. */
export interface Collaborator {
  replica: string;
  name: string;
  color: string;
  file_id: string | null;
}

export type RightPanel = "activity" | "preview" | "debug" | null;
export type Theme = "dark" | "light";
export type ChannelStatus = "connecting" | "online" | "offline" | "closed";

export const EMPTY_STATS: DocStats = {
  status: "loading",
  detail: "",
  outbox: 0,
  lastSeq: 0,
  headSeq: 0,
  length: 0,
  nodes: 0,
  tombstones: 0,
  pending: 0,
  clock: 0,
  replicaId: "",
  line: 1,
  col: 1,
  peers: [],
  version: 0,
};

interface WorkspaceState {
  projectId: string;
  projectName: string;
  files: FileInfo[];
  /** Open tabs, in order. */
  openIds: string[];
  activeId: string | null;
  collaborators: Collaborator[];
  activity: ActivityEvent[];
  channel: ChannelStatus;
  docs: Record<string, DocStats>;
  debugNodes: DebugNode[];
  panel: RightPanel;
  theme: Theme;
  forcedOffline: boolean;
  quickOpen: boolean;
  sidebarOpen: boolean;
  loadError: string;

  init(projectId: string, name: string, files: FileInfo[], activity: ActivityEvent[]): void;
  setFiles(files: FileInfo[]): void;
  openFile(id: string): void;
  closeFile(id: string): void;
  setActive(id: string | null): void;
  patchDoc(id: string, patch: Partial<DocStats>): void;
  setDebugNodes(nodes: DebugNode[]): void;
  setCollaborators(c: Collaborator[]): void;
  upsertCollaborator(c: Collaborator): void;
  removeCollaborator(replica: string): void;
  addActivity(e: ActivityEvent): void;
  set(p: Partial<WorkspaceState>): void;
  reset(): void;
}

const initial = {
  projectId: "",
  projectName: "",
  files: [] as FileInfo[],
  openIds: [] as string[],
  activeId: null as string | null,
  collaborators: [] as Collaborator[],
  activity: [] as ActivityEvent[],
  channel: "connecting" as ChannelStatus,
  docs: {} as Record<string, DocStats>,
  debugNodes: [] as DebugNode[],
  panel: "activity" as RightPanel,
  forcedOffline: false,
  quickOpen: false,
  sidebarOpen: true,
  loadError: "",
};

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ...initial,
  theme: "dark",

  init: (projectId, projectName, files, activity) => {
    // Open the README first when there is one, like a real project.
    const first = files.find((f) => /^readme(\.|$)/i.test(f.name)) ?? files[0];
    set({
      projectId,
      projectName,
      files,
      activity,
      openIds: first ? [first.id] : [],
      activeId: first?.id ?? null,
    });
  },

  setFiles: (files) => {
    const ids = new Set(files.map((f) => f.id));
    const { openIds, activeId } = get();
    const kept = openIds.filter((id) => ids.has(id));
    let active = activeId && ids.has(activeId) ? activeId : (kept[kept.length - 1] ?? null);
    if (active && !kept.includes(active)) kept.push(active);
    if (!active) active = null;
    set({ files, openIds: kept, activeId: active });
  },

  openFile: (id) =>
    set((s) => ({
      openIds: s.openIds.includes(id) ? s.openIds : [...s.openIds, id],
      activeId: id,
    })),

  closeFile: (id) =>
    set((s) => {
      const index = s.openIds.indexOf(id);
      const openIds = s.openIds.filter((x) => x !== id);
      const activeId =
        s.activeId === id ? (openIds[Math.min(index, openIds.length - 1)] ?? null) : s.activeId;
      return { openIds, activeId };
    }),

  setActive: (id) => set({ activeId: id }),

  patchDoc: (id, patch) =>
    set((s) => ({ docs: { ...s.docs, [id]: { ...(s.docs[id] ?? EMPTY_STATS), ...patch } } })),

  setDebugNodes: (debugNodes) => set({ debugNodes }),
  setCollaborators: (collaborators) => set({ collaborators }),
  upsertCollaborator: (c) =>
    set((s) => ({
      collaborators: [...s.collaborators.filter((x) => x.replica !== c.replica), c],
    })),
  removeCollaborator: (replica) =>
    set((s) => ({ collaborators: s.collaborators.filter((x) => x.replica !== replica) })),
  addActivity: (e) =>
    set((s) => {
      // An edit entry that grew replaces its older version instead of repeating.
      const rest = s.activity.filter((x) => x.id !== e.id);
      return { activity: [e, ...rest].slice(0, 100) };
    }),
  set: (p) => set(p),
  reset: () => set({ ...initial }),
}));
