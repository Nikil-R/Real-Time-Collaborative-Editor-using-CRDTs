import { create } from "zustand";
import type { Peer, Status } from "@rce/client";

/** UI state mirrored from the sync session (the session itself is not React state). */
export interface DebugNode {
  clock: number;
  replica: string;
  char: string;
  deleted: boolean;
}

interface EditorState {
  status: Status;
  detail: string;
  peers: Peer[];
  outbox: number;
  lastSeq: number;
  headSeq: number;
  length: number;
  nodes: number;
  tombstones: number;
  pending: number;
  clock: number;
  replicaId: string;
  forcedOffline: boolean;
  debugOpen: boolean;
  debugNodes: DebugNode[];
  patch(p: Partial<EditorState>): void;
  reset(): void;
}

const initial = {
  status: "loading" as Status,
  detail: "",
  peers: [] as Peer[],
  outbox: 0,
  lastSeq: 0,
  headSeq: 0,
  length: 0,
  nodes: 0,
  tombstones: 0,
  pending: 0,
  clock: 0,
  replicaId: "",
  forcedOffline: false,
  debugOpen: false,
  debugNodes: [] as DebugNode[],
};

export const useEditorStore = create<EditorState>((set) => ({
  ...initial,
  patch: (p) => set(p),
  reset: () => set({ ...initial }),
}));
