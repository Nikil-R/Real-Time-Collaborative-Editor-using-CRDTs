"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileCode2 } from "lucide-react";
import { CollabEditor } from "@/components/editor/CollabEditor";
import { QuickOpen } from "./QuickOpen";
import { RightPanel } from "./RightPanel";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { TopBar } from "./TopBar";
import { api } from "@/lib/api";
import { wsUrlFor } from "@/lib/config";
import { editors } from "@/lib/editor-registry";
import { getColor, getName } from "@/lib/identity";
import { ProjectChannel } from "@/lib/project-channel";
import { acquireReplica } from "@/lib/replica-id";
import { useWorkspace, type Theme } from "@/lib/workspace-store";

export function Workspace({ projectId }: { projectId: string }) {
  const [mounted, setMounted] = useState(false);
  const loadError = useWorkspace((s) => s.loadError);
  const projectName = useWorkspace((s) => s.projectName);
  const files = useWorkspace((s) => s.files);
  const openIds = useWorkspace((s) => s.openIds);
  const activeId = useWorkspace((s) => s.activeId);
  const channelState = useWorkspace((s) => s.channel);

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;
    const store = useWorkspace.getState();
    store.reset();
    const savedTheme = (localStorage.getItem("rce:theme") as Theme | null) ?? "dark";
    document.documentElement.dataset.theme = savedTheme;
    useWorkspace.setState({ theme: savedTheme });
    setMounted(true);

    void (async () => {
      let project;
      try {
        project = await api.getProject(projectId);
      } catch (e) {
        if (!cancelled) {
          useWorkspace.setState({
            loadError:
              (e as { status?: number }).status === 404
                ? "This workspace does not exist."
                : "Could not reach the server. Is it running?",
          });
        }
        return;
      }
      if (cancelled) return;
      useWorkspace.getState().init(project.id, project.name, project.files, []);
      document.title = `${project.name} · CRDT Workspace`;

      const lease = await acquireReplica(`project-${projectId}`);
      if (cancelled) {
        lease.release();
        return;
      }
      const channel = new ProjectChannel({
        replicaId: lease.replicaId,
        name: getName(),
        color: getColor(),
        wsUrl: wsUrlFor(`projects/${projectId}`),
        hooks: {
          onWelcome(w) {
            const s = useWorkspace.getState();
            s.setFiles(w.files);
            s.set({ projectName: w.project.name, activity: w.activity });
            s.setCollaborators(w.peers);
          },
          onFilesChanged: (f) => useWorkspace.getState().setFiles(f),
          onPeerJoined: (c) => useWorkspace.getState().upsertCollaborator(c),
          onFocus: (c) => useWorkspace.getState().upsertCollaborator(c),
          onPeerLeft: (r) => useWorkspace.getState().removeCollaborator(r),
          onActivity: (e) => useWorkspace.getState().addActivity(e),
          onState: (s) => useWorkspace.getState().set({ channel: s }),
        },
      });
      channel.start();
      channel.focus(useWorkspace.getState().activeId);
      const unsubscribe = useWorkspace.subscribe((s, prev) => {
        if (s.activeId !== prev.activeId) channel.focus(s.activeId);
      });
      const onOffline = (e: Event) => channel.setOffline((e as CustomEvent<boolean>).detail);
      const onOnline = () => channel.networkBecameAvailable();
      window.addEventListener("rce:offline", onOffline);
      window.addEventListener("online", onOnline);
      if (process.env.NEXT_PUBLIC_E2E === "1") {
        (window as unknown as { __rce?: unknown }).__rce = {
          editors,
          store: useWorkspace,
          activeText: () => {
            const id = useWorkspace.getState().activeId;
            return id ? (editors.get(id)?.view.state.doc.toString() ?? "") : "";
          },
        };
      }
      teardown = () => {
        unsubscribe();
        window.removeEventListener("rce:offline", onOffline);
        window.removeEventListener("online", onOnline);
        channel.stop();
        lease.release();
      };
      if (cancelled) teardown();
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [projectId]);

  if (loadError) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-app p-8 text-center">
        <p role="alert" data-testid="load-error" className="text-fg">
          {loadError}
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Back to start
        </Link>
      </main>
    );
  }
  if (!mounted || !projectName) {
    return (
      <main className="flex h-dvh items-center justify-center bg-app text-sm text-muted" data-testid="loading">
        Loading workspace…
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-app text-fg" data-testid="workspace" data-channel={channelState}>
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="relative min-h-0 flex-1 bg-panel" data-testid="editor-area">
            {openIds.map((id) => {
              const file = files.find((f) => f.id === id);
              if (!file) return null;
              return (
                <CollabEditor key={id} docId={id} fileName={file.name} active={id === activeId} claimSeed />
              );
            })}
            {openIds.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
                <FileCode2 size={40} className="text-faint" />
                <p className="text-sm">Open a file from the explorer to start editing.</p>
                <p className="text-xs text-faint">
                  Press <kbd className="rounded bg-raised px-1.5 py-0.5 font-mono">Ctrl P</kbd> to jump to a file.
                </p>
              </div>
            )}
          </div>
        </main>
        <RightPanel />
      </div>
      <StatusBar />
      <QuickOpen />
    </div>
  );
}
