"use client";

import { useEffect, useRef } from "react";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { DocSession, type PeerPresence } from "@rce/client";
import { wsUrlFor } from "@/lib/config";
import { DexieStore } from "@/lib/dexie-store";
import { remoteChangeSet, toSequentialChanges } from "@/lib/editor-binding";
import { colorFor, getName } from "@/lib/identity";
import { acquireReplica } from "@/lib/replica-id";
import { sessionRef } from "@/lib/session-registry";
import { useEditorStore } from "@/lib/store";
import { remoteCursors, setPeerCursors, type PeerCursor } from "./remote-cursors";

/** Marks transactions that come from the network, so they are not sent back. */
const External = Annotation.define<boolean>();

const DEBUG_NODE_LIMIT = 300;

export function CollabEditor({ docId }: { docId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => Promise<void>) | null = null;
    const store = useEditorStore.getState();
    store.reset();

    void (async () => {
      const lease = await acquireReplica(docId);
      if (cancelled || !host.current) {
        lease.release();
        return;
      }
      const name = getName();
      const color = colorFor(lease.replicaId);
      const presences = new Map<string, PeerPresence>();
      let session!: DocSession;
      let raf = 0;
      let statsTimer: ReturnType<typeof setTimeout> | null = null;

      const refreshCursors = () => {
        raf = 0;
        const peers: PeerCursor[] = [];
        for (const p of presences.values()) {
          const head = session.indexOfCursor(p.head);
          const anchor = session.indexOfCursor(p.anchor);
          if (head < 0 || anchor < 0) continue; // character not received yet
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
        const s = useEditorStore.getState();
        const nodes = doc.debugNodes();
        s.patch({
          outbox: session.outboxSize,
          lastSeq: session.lastSeq,
          headSeq: session.headSeq,
          length: view.state.doc.length,
          nodes: nodes.length,
          tombstones: nodes.filter((n) => n.deleted).length,
          pending: doc.pendingCount,
          clock: doc.currentClock,
          debugNodes: s.debugOpen
            ? nodes.slice(-DEBUG_NODE_LIMIT).map((n) => ({
                clock: n.id.clock,
                replica: n.id.replica,
                char: n.char,
                deleted: n.deleted,
              }))
            : [],
        });
      };
      const scheduleStats = () => {
        if (!statsTimer) statsTimer = setTimeout(updateStats, 80);
      };

      const view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: "",
          extensions: [
            history(),
            drawSelection(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.lineWrapping,
            remoteCursors(),
            EditorView.contentAttributes.of({ "data-testid": "editor-content", "aria-label": "Document" }),
            EditorView.updateListener.of((update) => {
              for (const tr of update.transactions) {
                if (tr.docChanged && !tr.annotation(External)) {
                  session.localEdit(toSequentialChanges(tr.changes));
                }
              }
              if (update.docChanged || update.selectionSet) {
                const sel = update.state.selection.main;
                session.setCursor(sel.anchor, sel.head);
              }
              if (update.docChanged) {
                scheduleCursors();
                scheduleStats();
              }
            }),
          ],
        }),
      });

      session = new DocSession({
        docId,
        replicaId: lease.replicaId,
        name,
        color,
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
            useEditorStore.getState().patch({ status, detail: detail ?? "" });
          },
          onPeers(peers) {
            useEditorStore.getState().patch({ peers });
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
      sessionRef.current = session;
      useEditorStore.getState().patch({ replicaId: lease.replicaId });
      if (process.env.NEXT_PUBLIC_E2E === "1") {
        (window as unknown as { __rce?: unknown }).__rce = { session, view };
      }

      const onOnline = () => session.networkBecameAvailable();
      window.addEventListener("online", onOnline);
      await session.start();

      teardown = async () => {
        window.removeEventListener("online", onOnline);
        if (raf) cancelAnimationFrame(raf);
        if (statsTimer) clearTimeout(statsTimer);
        sessionRef.current = null;
        await session.stop();
        view.destroy();
        lease.release();
      };
      if (cancelled) await teardown();
    })();

    return () => {
      cancelled = true;
      void teardown?.();
    };
  }, [docId]);

  return <div ref={host} className="h-full" data-testid="editor-host" />;
}
