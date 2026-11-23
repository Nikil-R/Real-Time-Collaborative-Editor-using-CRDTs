"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/config";
import { getName, setName } from "@/lib/identity";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default function Home() {
  const router = useRouter();
  const [name, setNameState] = useState("");
  const [openId, setOpenId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setNameState(getName()), []);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      setName(name);
      const res = await fetch(`${API_URL}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled" }),
      });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      const doc = (await res.json()) as { id: string };
      router.push(`/doc/${doc.id}`);
    } catch (e) {
      setError(`Could not create a document. Is the server running at ${API_URL}? (${String(e)})`);
      setBusy(false);
    }
  };

  const open = () => {
    const match = UUID_RE.exec(openId);
    if (!match) {
      setError("That does not look like a document link or id.");
      return;
    }
    setName(name);
    router.push(`/doc/${match[0].toLowerCase()}`);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Real-Time Collaborative Editor</h1>
        <p className="mt-2 text-stone-600">
          Type together in one document, even offline. Every character has a permanent id, so edits
          made at the same time always merge to the same text on every device. The merge logic is a
          CRDT (RGA) written from scratch.
        </p>
      </div>

      <label className="block text-sm font-medium">
        Your name
        <input
          data-testid="name-input"
          value={name}
          onChange={(e) => setNameState(e.target.value)}
          maxLength={40}
          className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2"
        />
      </label>

      <Button onClick={create} disabled={busy} data-testid="new-doc" className="h-11 text-base">
        {busy ? "Creating…" : "New document"}
      </Button>

      <div className="flex gap-2">
        <input
          value={openId}
          onChange={(e) => setOpenId(e.target.value)}
          placeholder="Paste a document link or id"
          className="min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
        />
        <Button variant="outline" onClick={open}>
          Open
        </Button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </main>
  );
}
