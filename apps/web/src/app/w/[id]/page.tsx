"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  if (!UUID_RE.test(id)) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-app p-8">
        <p role="alert" data-testid="load-error">
          That is not a valid workspace link.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Back to start
        </Link>
      </main>
    );
  }
  return <Workspace projectId={id} />;
}
