import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "./workspace-store";

const f = (id: string, name: string) => ({ id, name, created_at: null });
const state = () => useWorkspace.getState();

beforeEach(() => state().reset());

describe("workspace store", () => {
  it("opens the README first when a project loads", () => {
    state().init("p", "Demo", [f("1", "config.json"), f("2", "README.md"), f("3", "a.ts")], []);
    expect(state().openIds).toEqual(["2"]);
    expect(state().activeId).toBe("2");
  });

  it("opening a file adds a tab once and activates it", () => {
    state().init("p", "Demo", [f("1", "a.ts"), f("2", "b.ts")], []);
    state().openFile("2");
    state().openFile("2");
    expect(state().openIds).toEqual(["1", "2"]);
    expect(state().activeId).toBe("2");
  });

  it("closing the active tab activates its neighbour", () => {
    state().init("p", "Demo", [f("1", "a.ts"), f("2", "b.ts"), f("3", "c.ts")], []);
    state().openFile("2");
    state().openFile("3");
    state().closeFile("3");
    expect(state().activeId).toBe("2");
    state().closeFile("2");
    state().closeFile("1");
    expect(state().activeId).toBeNull();
  });

  it("drops tabs of files that were deleted by someone else", () => {
    state().init("p", "Demo", [f("1", "a.ts"), f("2", "b.ts")], []);
    state().openFile("2");
    state().setFiles([f("1", "a.ts")]);
    expect(state().openIds).toEqual(["1"]);
    expect(state().activeId).toBe("1");
  });

  it("a growing edit entry replaces its older version instead of repeating", () => {
    const edit = (count: number) => ({
      id: 7,
      ts: "t",
      actor: "A",
      kind: "edit" as const,
      file_id: "1",
      file_name: "a.ts",
      count,
    });
    state().addActivity(edit(3));
    state().addActivity({ ...edit(1), id: 8, kind: "file_created" });
    state().addActivity(edit(9));
    expect(state().activity.map((e) => [e.id, e.count])).toEqual([
      [7, 9],
      [8, 1],
    ]);
  });

  it("tracks collaborators and which file they are in", () => {
    state().upsertCollaborator({ replica: "r1", name: "Priya", color: "#f00", file_id: null });
    state().upsertCollaborator({ replica: "r1", name: "Priya", color: "#f00", file_id: "9" });
    expect(state().collaborators).toHaveLength(1);
    expect(state().collaborators[0]!.file_id).toBe("9");
    state().removeCollaborator("r1");
    expect(state().collaborators).toEqual([]);
  });
});
