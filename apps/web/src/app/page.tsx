"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowRight,
  Cloud,
  FileCode2,
  GitMerge,
  MousePointer2,
  Palette,
  WifiOff,
} from "lucide-react";
import { LogoMark } from "@/components/workspace/TopBar";
import { API_URL } from "@/lib/config";
import { api } from "@/lib/api";
import { getName, setName } from "@/lib/identity";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const REPO_URL = "https://github.com/Nikil-R/Real-Time-Collaborative-Editor-using-CRDTs-";

const FEATURES = [
  {
    icon: MousePointer2,
    title: "Live cursors and selections",
    text: "See who is where, with names and colours. Cursors stay on the right character even while others type before them.",
  },
  {
    icon: WifiOff,
    title: "Works offline",
    text: "Lose your connection and keep typing. Edits are saved in your browser and merge cleanly the moment you are back.",
  },
  {
    icon: GitMerge,
    title: "Conflict-free by design",
    text: "A hand-written CRDT gives every character a permanent id, so simultaneous edits always converge to the same text.",
  },
  {
    icon: FileCode2,
    title: "Multi-file workspace",
    text: "File tree, tabs, quick open, syntax highlighting for TypeScript, Python, JSON, Markdown, HTML and CSS.",
  },
  {
    icon: Activity,
    title: "Activity feed",
    text: "A shared history of who created, renamed and edited which file, updated live for everyone.",
  },
  {
    icon: Palette,
    title: "Dark and light themes",
    text: "A developer-tool interface with a Markdown preview and a debug view that shows the CRDT working.",
  },
];

const STACK = ["TypeScript", "Next.js", "CodeMirror 6", "FastAPI", "PostgreSQL", "Redis", "WebSockets", "IndexedDB"];

/** A static picture of the product: two people editing at once. */
function EditorMock() {
  const line = (n: number, children: React.ReactNode) => (
    <div className="flex gap-4">
      <span className="w-4 text-right text-faint select-none">{n}</span>
      <span>{children}</span>
    </div>
  );
  const kw = (t: string) => <span style={{ color: "#c678dd" }}>{t}</span>;
  const fn = (t: string) => <span style={{ color: "#61afef" }}>{t}</span>;
  const str = (t: string) => <span style={{ color: "#98c379" }}>{t}</span>;
  const caret = (name: string, color: string) => (
    <span className="relative inline-block h-[1.1em] w-0 border-l-2 align-middle" style={{ borderColor: color }}>
      <span
        className="absolute -top-5 left-[-2px] rounded px-1.5 py-px font-sans text-[10px] font-semibold whitespace-nowrap text-white"
        style={{ backgroundColor: color }}
      >
        {name}
      </span>
    </span>
  );
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-xl border border-line bg-panel shadow-[0_30px_80px_-20px_rgba(139,108,255,0.35)]"
    >
      <div className="flex items-center gap-2 border-b border-line bg-panel2 px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 rounded bg-panel px-2.5 py-0.5 font-mono text-[11px] text-muted">src/app.ts</span>
        <span className="ml-auto flex -space-x-1.5">
          <span className="h-5 w-5 rounded-full border-2 border-panel2 bg-[#e57373]" />
          <span className="h-5 w-5 rounded-full border-2 border-panel2 bg-[#64b5f6]" />
        </span>
      </div>
      <div className="space-y-1 p-4 font-mono text-[13px] leading-6 text-fg">
        {line(1, <>{kw("interface")} <span style={{ color: "#e5c07b" }}>User</span> {"{"}</>)}
        {line(2, <>&nbsp;&nbsp;name: <span style={{ color: "#e5c07b" }}>string</span>;</>)}
        {line(3, <>{"}"}</>)}
        {line(4, <></>)}
        {line(
          5,
          <>
            {kw("export function")} {fn("greet")}(user: <span style={{ color: "#e5c07b" }}>User</span>) {"{"}
          </>,
        )}
        {line(
          6,
          <>
            &nbsp;&nbsp;{kw("return")} {str("`Hello, ${user.name}")}
            {caret("Priya", "#e57373")}
            {str("!`")};
          </>,
        )}
        {line(7, <>{"}"}</>)}
        {line(
          8,
          <>
            {fn("console")}.log({fn("greet")}({"{"} name: {str('"Rahul"')}
            {caret("Rahul", "#64b5f6")} {"}"}));
          </>,
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [name, setNameState] = useState("");
  const [project, setProject] = useState("My workspace");
  const [openId, setOpenId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setNameState(getName()), []);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      setName(name);
      const created = await api.createProject(project.trim() || "My workspace");
      router.push(`/w/${created.id}`);
    } catch (e) {
      setError(`Could not create a workspace. Is the server running at ${API_URL}? (${String(e)})`);
      setBusy(false);
    }
  };

  const open = () => {
    const match = UUID_RE.exec(openId);
    if (!match) {
      setError("That does not look like a workspace link.");
      return;
    }
    setName(name);
    router.push(`/w/${match[0].toLowerCase()}`);
  };

  return (
    <div className="min-h-dvh bg-app text-fg">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px]"
        style={{
          background:
            "radial-gradient(60% 60% at 70% 0%, rgba(139,108,255,0.22), transparent 70%), radial-gradient(40% 40% at 10% 10%, rgba(34,211,238,0.10), transparent 70%)",
        }}
      />
      <nav className="relative mx-auto flex max-w-6xl items-center gap-3 px-6 py-5">
        <LogoMark size={28} />
        <span className="font-semibold tracking-tight">CRDT Workspace</span>
        <a href="#how" className="ml-auto text-sm text-muted hover:text-fg">
          How it works
        </a>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-fg">
          GitHub
        </a>
      </nav>

      <main className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pt-10 pb-20 lg:grid-cols-2 lg:pt-16">
        <section>
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted">
            <Cloud size={13} className="text-accent" /> Real-time · Offline-first · Conflict-free
          </p>
          <h1 className="text-4xl leading-[1.1] font-bold tracking-tight sm:text-5xl">
            Code together,
            <br />
            <span style={{ background: "linear-gradient(90deg,#8b6cff,#22d3ee)", WebkitBackgroundClip: "text", color: "transparent" }}>
              in real time.
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-lg text-muted">
            A multi-file collaborative editor where everyone types at once and everyone always ends up with the
            same code, even after working offline. No account, just a link.
          </p>

          <div className="mt-8 max-w-md space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                Your name
                <input
                  data-testid="name-input"
                  value={name}
                  onChange={(e) => setNameState(e.target.value)}
                  maxLength={40}
                  className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                />
              </label>
              <label className="text-xs text-muted">
                Workspace name
                <input
                  data-testid="project-input"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  maxLength={60}
                  className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                />
              </label>
            </div>
            <button
              onClick={create}
              disabled={busy}
              data-testid="new-workspace"
              className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent text-base font-semibold text-white shadow-lg shadow-accent/30 transition hover:opacity-95 disabled:opacity-60"
            >
              {busy ? "Creating…" : "Create a workspace"}
              <ArrowRight size={18} className="transition group-hover:translate-x-0.5" />
            </button>
            <div className="flex gap-2">
              <input
                value={openId}
                onChange={(e) => setOpenId(e.target.value)}
                placeholder="…or paste a workspace link"
                aria-label="Workspace link"
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
              />
              <button onClick={open} className="rounded-lg border border-line bg-panel px-4 text-sm hover:border-accent">
                Open
              </button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-bad">
                {error}
              </p>
            )}
          </div>
        </section>
        <section className="lg:pl-6">
          <EditorMock />
        </section>
      </main>

      <section className="relative mx-auto max-w-6xl px-6 pb-20" aria-label="Features">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <article key={title} className="rounded-xl border border-line bg-panel p-5 transition hover:border-accent/60">
              <span className="mb-3 inline-flex rounded-lg bg-accent-soft p-2 text-accent">
                <Icon size={18} />
              </span>
              <h2 className="font-semibold">{title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="how" className="relative mx-auto max-w-6xl scroll-mt-8 px-6 pb-20">
        <h2 className="text-2xl font-bold tracking-tight">How it merges without a referee</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[
            ["1", "Every character has an id", "Each keystroke becomes “insert this character after the one with id X”, never “insert at position 5”."],
            ["2", "Order does not matter", "Edits can arrive late, twice or out of order, and every device still computes the same text."],
            ["3", "The server only relays", "A FastAPI server stores and forwards edits in PostgreSQL and Redis. It never decides who wins."],
          ].map(([n, t, d]) => (
            <div key={n} className="rounded-xl border border-line bg-panel p-5">
              <span className="font-mono text-sm text-accent">{n}</span>
              <h3 className="mt-2 font-semibold">{t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
        <ul className="mt-8 flex flex-wrap gap-2" aria-label="Technology">
          {STACK.map((s) => (
            <li key={s} className="rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted">
              {s}
            </li>
          ))}
        </ul>
      </section>

      <footer className="relative border-t border-line py-6 text-center text-xs text-faint">
        Built by Nikil R · a hand-written RGA CRDT, tested with thousands of random edit schedules
      </footer>
    </div>
  );
}
