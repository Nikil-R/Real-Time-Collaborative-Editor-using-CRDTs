import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { Replica } from "@rce/crdt";
import { remoteChangeSet, toSequentialChanges } from "./editor-binding";

function applySequential(text: string, changes: { from: number; to: number; insert: string }[]) {
  let out = text;
  for (const c of changes) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

describe("toSequentialChanges", () => {
  it("shifts later changes by the net length of earlier ones", () => {
    const doc = "0123456789";
    const cs = ChangeSet.of(
      [
        { from: 1, to: 3, insert: "AAAA" }, // +2
        { from: 5, to: 6, insert: "" }, // -1
        { from: 9, insert: "Z" },
      ],
      doc.length,
    );
    const seq = toSequentialChanges(cs);
    expect(applySequential(doc, seq)).toBe(cs.apply(Text.of([doc])).toString());
  });

  it("returns an empty list for an empty change set", () => {
    expect(toSequentialChanges(ChangeSet.empty(5))).toEqual([]);
  });

  it("drives a replica so that it matches CodeMirror's text", () => {
    const replica = new Replica("a");
    let doc = Text.of(["hello world"]);
    replica.localInsert(0, "hello world");
    const cs = ChangeSet.of(
      [
        { from: 0, to: 5, insert: "HELLO" },
        { from: 11, insert: "!\nnext line" },
      ],
      doc.length,
    );
    for (const c of toSequentialChanges(cs)) {
      if (c.to > c.from) replica.localDelete(c.from, c.to - c.from);
      if (c.insert) replica.localInsert(c.from, c.insert);
    }
    doc = cs.apply(doc);
    expect(replica.getText()).toBe(doc.toString());
  });
});

describe("remoteChangeSet", () => {
  it("composes sequential remote changes into one CodeMirror change set", () => {
    const local = new Replica("a");
    const remote = new Replica("b");
    remote.applyRemote(local.localInsert(0, "abcdef"));
    const doc = Text.of(["abcdef"]);

    const ops = [...local.localInsert(3, "XY"), ...local.localDelete(0, 2)];
    const changes = remote.applyRemote(ops);
    const next = remoteChangeSet(doc.length, changes).apply(doc);
    expect(next.toString()).toBe(remote.getText());
    expect(remote.getText()).toBe("cXYdef");
  });

  it("handles a list of many single-character inserts", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const ops = a.localInsert(0, "typing...");
    const changes = b.applyRemote([...ops].reverse()); // out of order delivery
    const next = remoteChangeSet(0, changes).apply(Text.of([""]));
    expect(next.toString()).toBe("typing...");
  });
});
