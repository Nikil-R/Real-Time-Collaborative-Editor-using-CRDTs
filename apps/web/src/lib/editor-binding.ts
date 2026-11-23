/**
 * Pure helpers that translate between CodeMirror 6 change sets and the
 * sequential `Change[]` the CRDT replica works with (docs/03-CRDT-DESIGN.md
 * section 15). No DOM access, so they are unit tested in Node.
 */
import { ChangeSet } from "@codemirror/state";
import type { Change } from "@rce/crdt";

/**
 * CodeMirror reports every change of a transaction in coordinates of the
 * document BEFORE the transaction. The replica applies edits one after the
 * other, so each position is shifted by the net length change of the edits
 * that came before it.
 */
export function toSequentialChanges(changes: ChangeSet): Change[] {
  const out: Change[] = [];
  let shift = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    out.push({ from: fromA + shift, to: toA + shift, insert: text });
    shift += text.length - (toA - fromA);
  });
  return out;
}

/**
 * The reverse: remote changes arrive one after the other (each in the
 * coordinates of the text after the previous one). Compose them into one
 * CodeMirror change set against a document of `docLength`.
 */
export function remoteChangeSet(docLength: number, changes: readonly Change[]): ChangeSet {
  let set = ChangeSet.empty(docLength);
  for (const c of changes) {
    const next = ChangeSet.of({ from: c.from, to: c.to, insert: c.insert }, set.newLength);
    set = set.compose(next);
  }
  return set;
}
