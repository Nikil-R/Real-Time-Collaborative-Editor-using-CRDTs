import { describe, expect, it } from "vitest";
import { baseName, isMarkdown, languageFor } from "./languages";

describe("languageFor", () => {
  it("picks the language from the extension, case-insensitively", () => {
    expect(languageFor("src/app.ts").id).toBe("typescript");
    expect(languageFor("main.PY").id).toBe("python");
    expect(languageFor("config.json").label).toBe("JSON");
    expect(languageFor("component.tsx").id).toBe("tsx");
  });
  it("falls back to plain text", () => {
    expect(languageFor("Makefile").id).toBe("plaintext");
    expect(languageFor("trailingdot.").id).toBe("plaintext");
    expect(languageFor("weird.unknownext").id).toBe("plaintext");
  });
  it("detects markdown and splits paths", () => {
    expect(isMarkdown("docs/README.md")).toBe(true);
    expect(isMarkdown("a.py")).toBe(false);
    expect(baseName("src/lib/util.ts")).toBe("util.ts");
    expect(baseName("top.txt")).toBe("top.txt");
  });
});
