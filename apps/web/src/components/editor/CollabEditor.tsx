"use client";

import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { DocSession } from "@rce/client";
import { api } from "@/lib/api";
import { wsUrlFor } from "@/lib/config";
import { DexieStore } from "@/lib/dexie-store";
import { editors } from "@/lib/editor-registry";
import { remoteChangeSet, toSequentialChanges } from "@/lib/editor-binding";
import { getColor, getName } from "@/lib/identity";
import { languageFor } from "@/lib/languages";
import { acquireReplica } from "@/lib/replica-id";
import { useWorkspace } from "@/lib/workspace-store";
import { themeExtension } from "./editor-theme";
import { remoteCursors, setPeerCursors, type PeerCursor } from "./remote-cursors";
import type { PeerPresence } from "@rce/client";

/** Marks transactions that come from the network, so they are not sent back. */
const External = Annotation.define<boolean>();
const DEBUG_NODE_LIMIT = 300;

interface Props {
  docId: string;
  fileName: string;
  active: boolean;
  /** Workspace files may have starter text; one client claims and types it. */
  claimSeed: boolean;
}

export function CollabEditor({ docId, fileName, active, claimSeed }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;

  // One view and one sync session per open file, for as long as its tab is open.
  useEffect(() => {
    let cancelled = false;
    let teardown: (() => Promise<void>) | null = null;
    const patchDoc = useWorkspace.getState().patchDoc;

    void (async () => {
      const lease = await acquireReplica(docId);
      if (cancelled || !host.current) {
        lease.release();
        return;
      }
      const presences = new Map<string, PeerPresence>();
      let session!: DocSession;
      let raf = 0;
      let statsTimer: ReturnType<typeof setTimeout> | null = null;
      let seeded = false;

      const refreshCursors = () => {
        raf = 0;
        const peers: PeerCursor[] = [];
        for (const p of presences.values()) {
          const head = session.indexOfCursor(p.head);
          const anchor = session.indexOfCursor(p.anchor);
          if (head < 0 || anchor < 0) continue;
          peers.push({ replica: p.replica, name: p.name, color: p.color, anchor, head });
        }
        view.dispatch({ effects: setPeerCursors.of(peers), annotations: External.of(true) });
      };
      const scheduleCursors = () => {
        if (!raf) raf = requestAnimationFrame(refreshCursors);
      };

      const updateStats = () => {
        statsTimer = null;
        const doc = session.doc;
        const nodes = doc.debugNodes();
        const sel = view.state.selection.main;
        const line = view.state.doc.lineAt(sel.head);
        patchDoc(docId, {
          outbox: session.outboxSize,
          lastSeq: session.lastSeq,
          headSeq: session.headSeq,
          length: view.state.doc.length,
          nodes: nodes.length,
          tombstones: nodes.filter((n) => n.deleted).length,
          pending: doc.pendingCount,
          clock: doc.currentClock,
          line: line.number,
          col: sel.head - line.from + 1,
          peers: session.peerList,
          version: (useWorkspace.getState().docs[docId]?.version ?? 0) + 1,
        });
        const s = useWorkspace.getState();
        if (s.activeId === docId && s.panel === "debug") {
          s.setDebugNodes(
            nodes.slice(-DEBUG_NODE_LIMIT).map((n) => ({
              clock: n.id.clock,
              replica: n.id.replica,
              char: n.char,
              deleted: n.deleted,
            })),
          );
        }
      };
      const scheduleStats = () => {
        if (!statsTimer) statsTimer = setTimeout(updateStats, 80);
      };

      const view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: "",
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            autocompletion(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            EditorView.lineWrapping,
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              ...historyKeymap,
              ...foldKeymap,
              ...completionKeymap,
              indentWithTab,
            ]),
            remoteCursors(),
            languageCompartment.current.of([]),
            themeCompartment.current.of(themeExtension(useWorkspace.getState().theme)),
            EditorView.contentAttributes.of({
              "data-testid": "editor-content",
              "aria-label": "Code editor",
            }),
            EditorView.updateListener.of((update) => {
              for (const tr of update.transactions) {
                if (tr.docChanged && !tr.annotation(External)) {
                  session.localEdit(toSequentialChanges(tr.changes));
                }
              }
              if (update.docChanged || update.selectionSet) {
                const sel = update.state.selection.main;
                session.setCursor(sel.anchor, sel.head);
                scheduleStats();
              }
              if (update.docChanged) scheduleCursors();
            }),
          ],
        }),
      });
      viewRef.current = view;

      // Syntax highlighting is loaded on demand for this file's language.
      void languageFor(fileNameRef.current)
        .load()
        .then((ext) => {
          if (!cancelled) view.dispatch({ effects: languageCompartment.current.reconfigure(ext) });
        });

      const maybeSeed = () => {
        if (!claimSeed || seeded || session.text !== "" || session.headSeq !== 0) return;
        seeded = true;
        void api
          .claimSeed(docId)
          .then(({ text }) => {
            // Only the one client that wins the claim types the starter text in.
            if (text && view.state.doc.length === 0) {
              view.dispatch({ changes: { from: 0, insert: text } });
            }
          })
          .catch(() => {
            seeded = false; // try again on the next connection
          });
      };

      session = new DocSession({
        docId,
        replicaId: lease.replicaId,
        name: getName(),
        color: getColor(),
        wsUrl: wsUrlFor(docId),
        store: new DexieStore(docId, lease.replicaId),
        hooks: {
          onReset(text) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: text },
              annotations: [External.of(true), Transaction.addToHistory.of(false)],
            });
          },
          onRemoteChanges(changes) {
            view.dispatch({
              changes: remoteChangeSet(view.state.doc.length, changes),
              annotations: [External.of(true), Transaction.addToHistory.of(false)],
            });
            scheduleCursors();
          },
          onStatus(status, detail) {
            patchDoc(docId, { status, detail: detail ?? "" });
            if (status === "online") maybeSeed();
          },
          onPeers(peers) {
            patchDoc(docId, { peers });
            const alive = new Set(peers.map((p) => p.replica));
            for (const id of [...presences.keys()]) if (!alive.has(id)) presences.delete(id);
            scheduleCursors();
          },
          onPresence(p) {
            presences.set(p.replica, p);
            scheduleCursors();
          },
          onPeerLeft(replica) {
            presences.delete(replica);
            scheduleCursors();
          },
          onActivity: scheduleStats,
        },
      });
      editors.set(docId, { session, view });
      patchDoc(docId, { replicaId: lease.replicaId });
      if (useWorkspace.getState().forcedOffline) session.setOfflineMode(true);

      const onOnline = () => session.networkBecameAvailable();
      window.addEventListener("online", onOnline);
      await session.start();

      teardown = async () => {
        window.removeEventListener("online", onOnline);
        if (raf) cancelAnimationFrame(raf);
        if (statsTimer) clearTimeout(statsTimer);
        editors.delete(docId);
        await session.stop();
        view.destroy();
        viewRef.current = null;
        lease.release();
      };
      if (cancelled) await teardown();
    })();

    return () => {
      cancelled = true;
      void teardown?.();
    };
    // The session belongs to the file; a rename or a theme change must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Renaming a file can change its language.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let live = true;
    void languageFor(fileName)
      .load()
      .then((ext) => {
        if (live) view.dispatch({ effects: languageCompartment.current.reconfigure(ext) });
      });
    return () => {
      live = false;
    };
  }, [fileName]);

  // Follow the app theme.
  useEffect(() => {
    const apply = (theme: "dark" | "light") => {
      viewRef.current?.dispatch({
        effects: themeCompartment.current.reconfigure(themeExtension(theme)),
      });
    };
    return useWorkspace.subscribe((s, prev) => {
      if (s.theme !== prev.theme) apply(s.theme);
    });
  }, []);

  // Give the editor keyboard focus when its tab becomes the active one.
  useEffect(() => {
    if (active) viewRef.current?.focus();
  }, [active]);

  return (
    <div
      ref={host}
      className="h-full"
      data-testid="editor-pane"
      data-file={fileName}
      data-active={active}
      hidden={!active}
    />
  );
}
