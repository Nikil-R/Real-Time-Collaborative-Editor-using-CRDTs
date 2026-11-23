import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Render Markdown to HTML that is safe to insert into the page.
 *
 * Another collaborator controls this text, so it is untrusted: the HTML that
 * `marked` produces is passed through DOMPurify, which removes scripts, event
 * handlers and `javascript:` links. Links open in a new tab without access to
 * this page.
 */
let hooked = false;

export function renderMarkdown(source: string): string {
  if (!hooked) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    });
    hooked = true;
  }
  const html = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // A shared document must not be able to plant a fake login form or overlay the page.
    FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "style", "iframe", "object", "embed", "link", "meta"],
    FORBID_ATTR: ["style", "action", "formaction"],
  });
}
