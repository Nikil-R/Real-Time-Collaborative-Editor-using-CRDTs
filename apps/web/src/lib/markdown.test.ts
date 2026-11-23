// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders ordinary Markdown", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text and `code`.\n\n- one\n- two");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("removes scripts and event handlers", () => {
    const html = renderMarkdown(
      '<script>window.__xss=1</script><img src=x onerror="window.__xss=2">\n\n<b onclick="alert(1)">hi</b>',
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).toContain("hi");
  });

  it("neutralises javascript: links and opens real links safely", () => {
    const bad = renderMarkdown("[click](javascript:alert(1))");
    expect(bad).not.toMatch(/javascript:/i);
    const good = renderMarkdown("[site](https://example.com)");
    expect(good).toContain('href="https://example.com"');
    expect(good).toContain('rel="noopener noreferrer nofollow"');
    expect(good).toContain('target="_blank"');
  });

  it("removes iframes and forms", () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe><form action="/x"><input></form>');
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/<input/i);
    expect(renderMarkdown('<p style="position:fixed;inset:0">x</p>')).not.toMatch(/style=/i);
  });
});
