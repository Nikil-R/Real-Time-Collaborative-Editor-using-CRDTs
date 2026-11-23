"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { CollabEditor } from "@/components/editor/CollabEditor";
import { DebugPanel } from "@/components/editor/DebugPanel";
import { DocHeader } from "@/components/editor/DocHeader";
import { useEditorStore } from "@/lib/store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function DocPage() {
  const params = useParams<{ id: string }>();
  const docId = params.id;
  const debugOpen = useEditorStore((s) => s.debugOpen);
  const status = useEditorStore((s) => s.status);
  const detail = useEditorStore((s) => s.detail);

  if (!UUID_RE.test(docId)) {
    return (
      <main className="p-8">
        <p>That is not a valid document id.</p>
        <Link href="/" className="text-blue-700 underline">
          Back to start
        </Link>
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <DocHeader docId={docId} />
      {status === "closed" && detail && (
        <div role="alert" data-testid="doc-error" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          {detail.startsWith("DOC_NOT_FOUND")
            ? "This document does not exist on the server."
            : detail}{" "}
          <Link href="/" className="underline">
            Back to start
          </Link>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <CollabEditor docId={docId} />
        </div>
        {debugOpen && <DebugPanel />}
      </div>
    </div>
  );
}
