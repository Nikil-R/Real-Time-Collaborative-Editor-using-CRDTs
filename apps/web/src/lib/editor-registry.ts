import type { EditorView } from "@codemirror/view";
import type { DocSession } from "@rce/client";

/**
 * Every open file has its own editor view and sync session. They live outside
 * React state (long-lived objects with their own timers); this registry lets
 * the rest of the UI (status bar, debug panel, offline switch) reach them.
 */
export interface OpenEditor {
  session: DocSession;
  view: EditorView;
}

export const editors = new Map<string, OpenEditor>();

export function setAllOffline(offline: boolean): void {
  for (const { session } of editors.values()) session.setOfflineMode(offline);
}
