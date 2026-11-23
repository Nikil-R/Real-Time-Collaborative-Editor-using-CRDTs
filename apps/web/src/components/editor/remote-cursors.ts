/**
 * Remote cursors and selections as a CodeMirror 6 extension.
 *
 * The positions come from character ids (resolved against the local replica
 * after every change), so they stay on the right character while text is
 * being typed around them. Names are put in with `textContent`, never HTML.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface PeerCursor {
  replica: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

export const setPeerCursors = StateEffect.define<PeerCursor[]>();

class CaretWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  override toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-peer-caret";
    caret.style.borderLeftColor = this.color;
    caret.setAttribute("data-testid", "remote-caret");
    caret.setAttribute("data-peer", this.name);
    const label = document.createElement("span");
    label.className = "cm-peer-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name; // textContent: a name like "<img onerror=...>" stays text
    caret.appendChild(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function build(peers: PeerCursor[], docLength: number): DecorationSet {
  const ranges = [];
  for (const p of peers) {
    const head = Math.min(Math.max(p.head, 0), docLength);
    const anchor = Math.min(Math.max(p.anchor, 0), docLength);
    if (anchor !== head) {
      ranges.push(
        Decoration.mark({ attributes: { style: `background-color:${p.color}33` } }).range(
          Math.min(anchor, head),
          Math.max(anchor, head),
        ),
      );
    }
    ranges.push(
      Decoration.widget({ widget: new CaretWidget(p.name, p.color), side: 1 }).range(head),
    );
  }
  return Decoration.set(ranges, true);
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPeerCursors)) return build(e.value, tr.state.doc.length);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function remoteCursors(): Extension {
  return field;
}
