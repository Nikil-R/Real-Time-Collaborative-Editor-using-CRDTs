import { describe, expect, it } from "vitest";
import { buildTree, initials, timeAgo } from "./format";

describe("timeAgo", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  it("uses friendly units", () => {
    expect(timeAgo(ago(3), now)).toBe("just now");
    expect(timeAgo(ago(30), now)).toBe("30 s ago");
    expect(timeAgo(ago(5 * 60), now)).toBe("5 min ago");
    expect(timeAgo(ago(3 * 3600), now)).toBe("3 h ago");
    expect(timeAgo(ago(2 * 86400), now)).toBe("2 d ago");
  });
  it("never goes negative for clocks that disagree", () => {
    expect(timeAgo(new Date(now + 60_000).toISOString(), now)).toBe("just now");
  });
});

describe("initials", () => {
  it("takes the first character, including emoji", () => {
    expect(initials("priya")).toBe("P");
    expect(initials("  rahul")).toBe("R");
    expect(initials("😀 fun")).toBe("😀");
    expect(initials("")).toBe("?");
  });
});

describe("buildTree", () => {
  const files = [
    { id: "1", name: "README.md" },
    { id: "2", name: "src/app.ts" },
    { id: "3", name: "src/lib/util.py" },
    { id: "4", name: "a.json" },
    { id: "5", name: "src/b.css" },
  ];
  it("puts folders first and sorts case-insensitively", () => {
    const tree = buildTree(files);
    expect(tree.map((n) => n.name)).toEqual(["src", "a.json", "README.md"]);
    const src = tree[0]!;
    expect(src.children.map((n) => n.name)).toEqual(["lib", "app.ts", "b.css"]);
    expect(src.children[0]!.children[0]).toMatchObject({ name: "util.py", fileId: "3", path: "src/lib/util.py" });
  });
  it("keeps a file and a folder with the same name apart", () => {
    const tree = buildTree([
      { id: "1", name: "x" },
      { id: "2", name: "x/y.txt" },
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.filter((n) => n.fileId === undefined)).toHaveLength(1);
  });
});
