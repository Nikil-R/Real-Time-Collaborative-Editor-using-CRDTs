/**
 * Which syntax highlighting a file gets, chosen from its extension. Language
 * packages are loaded on demand so the editor starts fast.
 */
import type { Extension } from "@codemirror/state";

export interface LanguageInfo {
  id: string;
  label: string;
  /** Short badge text and colour shown next to the file name. */
  badge: string;
  color: string;
  load: () => Promise<Extension>;
}

const none = (): Promise<Extension> => Promise.resolve([]);

const js = (jsx: boolean, ts: boolean) => async (): Promise<Extension> =>
  (await import("@codemirror/lang-javascript")).javascript({ jsx, typescript: ts });

const LANGUAGES: Record<string, LanguageInfo> = {
  ts: { id: "typescript", label: "TypeScript", badge: "TS", color: "#3b82f6", load: js(false, true) },
  tsx: { id: "tsx", label: "TypeScript React", badge: "TSX", color: "#38bdf8", load: js(true, true) },
  js: { id: "javascript", label: "JavaScript", badge: "JS", color: "#facc15", load: js(false, false) },
  jsx: { id: "jsx", label: "JavaScript React", badge: "JSX", color: "#fbbf24", load: js(true, false) },
  mjs: { id: "javascript", label: "JavaScript", badge: "JS", color: "#facc15", load: js(false, false) },
  py: {
    id: "python",
    label: "Python",
    badge: "PY",
    color: "#34d399",
    load: async () => (await import("@codemirror/lang-python")).python(),
  },
  json: {
    id: "json",
    label: "JSON",
    badge: "{}",
    color: "#fb923c",
    load: async () => (await import("@codemirror/lang-json")).json(),
  },
  md: {
    id: "markdown",
    label: "Markdown",
    badge: "MD",
    color: "#a78bfa",
    load: async () => (await import("@codemirror/lang-markdown")).markdown(),
  },
  html: {
    id: "html",
    label: "HTML",
    badge: "<>",
    color: "#f87171",
    load: async () => (await import("@codemirror/lang-html")).html(),
  },
  css: {
    id: "css",
    label: "CSS",
    badge: "#",
    color: "#60a5fa",
    load: async () => (await import("@codemirror/lang-css")).css(),
  },
};

const PLAIN: LanguageInfo = {
  id: "plaintext",
  label: "Plain text",
  badge: "TXT",
  color: "#94a3b8",
  load: none,
};

export function languageFor(fileName: string): LanguageInfo {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return PLAIN;
  return LANGUAGES[fileName.slice(dot + 1).toLowerCase()] ?? PLAIN;
}

export function isMarkdown(fileName: string): boolean {
  return languageFor(fileName).id === "markdown";
}

/** Base name of a path: `src/app.ts` -> `app.ts`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
