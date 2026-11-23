import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Theme } from "@/lib/workspace-store";

/** Editor chrome that follows the app's CSS variables in both themes. */
const chrome = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--panel)", color: "var(--text)", fontSize: "14px" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0" },
  ".cm-gutters": {
    backgroundColor: "var(--panel)",
    color: "var(--faint)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLine": { backgroundColor: "var(--accent-soft)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-panels": { backgroundColor: "var(--panel2)", color: "var(--text)" },
  ".cm-tooltip": {
    backgroundColor: "var(--raised)",
    border: "1px solid var(--line)",
    color: "var(--text)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent)" },
});

export function themeExtension(theme: Theme): Extension {
  return theme === "dark"
    ? [oneDark, chrome]
    : [syntaxHighlighting(defaultHighlightStyle, { fallback: true }), chrome];
}
