import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API = "http://localhost:8100";

async function newDoc(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/api/documents`, { data: { title: "e2e" } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** The text exactly as CodeMirror holds it. */
function text(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __rce: { view: { state: { doc: { toString(): string } } } } };
    return w.__rce.view.state.doc.toString();
  });
}


/** Text before and after Priya's caret, measured with DOM ranges inside its line. */
function around(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-peer="Priya"]')!;
    const line = el.closest(".cm-line")!;
    const before = document.createRange();
    before.setStart(line, 0);
    before.setEndBefore(el);
    const after = document.createRange();
    after.setStartAfter(el);
    after.setEnd(line, line.childNodes.length);
    return `${before.toString()}|${after.toString()}`;
  });
}

async function openDoc(page: Page, id: string, name: string): Promise<void> {
  await page.addInitScript((n) => localStorage.setItem("rce:name", n), name);
  await page.goto(`/doc/${id}`);
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "online");
}

async function typeAtStart(page: Page, s: string): Promise<void> {
  await page.getByTestId("editor-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(s, { delay: 15 });
}

test("typing in one window appears in the other", async ({ browser, request }) => {
  const id = await newDoc(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openDoc(a, id, "Priya");
  await openDoc(b, id, "Rahul");

  await typeAtStart(a, "Hello from Priya");
  await expect.poll(() => text(b)).toBe("Hello from Priya");
  await ctx.close();
});

test("simultaneous typing at the same spot converges", async ({ browser, request }) => {
  const id = await newDoc(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openDoc(a, id, "Priya");
  await openDoc(b, id, "Rahul");

  await Promise.all([typeAtStart(a, "AAAAAAAAAA"), typeAtStart(b, "BBBBBBBBBB")]);
  await expect.poll(async () => (await text(a)).length).toBe(20);
  await expect.poll(async () => (await text(b)).length).toBe(20);
  expect(await text(a)).toBe(await text(b));
  expect([...(await text(a))].sort().join("")).toBe("AAAAAAAAAABBBBBBBBBB");
  await ctx.close();
});

test("offline edits merge after reconnecting; nothing is lost", async ({ browser, request }) => {
  const id = await newDoc(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openDoc(a, id, "Priya");
  await openDoc(b, id, "Rahul");
  await typeAtStart(a, "base ");
  await expect.poll(() => text(b)).toBe("base ");

  await b.getByTestId("toggle-offline").click();
  await expect(b.getByTestId("status")).toHaveAttribute("data-status", "offline");
  await expect(b.getByTestId("status")).toContainText("saved locally");

  // Both keep typing, B while offline: typing never blocks.
  await b.getByTestId("editor-content").click();
  await b.keyboard.press("Control+End");
  await b.keyboard.type("offline-B", { delay: 10 });
  await a.getByTestId("editor-content").click();
  await a.keyboard.press("Control+End");
  await a.keyboard.type("online-A", { delay: 10 });
  await expect(b.getByTestId("outbox")).toContainText("unsent");
  expect(await text(b)).toContain("offline-B");
  expect(await text(a)).not.toContain("offline-B");

  await b.getByTestId("toggle-offline").click(); // back online
  await expect(b.getByTestId("status")).toHaveAttribute("data-status", "online");
  await expect.poll(async () => (await text(a)).includes("offline-B")).toBe(true);
  await expect.poll(async () => (await text(b)).includes("online-A")).toBe(true);
  expect(await text(a)).toBe(await text(b));
  await expect(b.getByTestId("outbox")).toHaveCount(0);
  await ctx.close();
});

test("a reload keeps the document and unsent edits, then delivers them", async ({
  browser,
  request,
}) => {
  const id = await newDoc(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openDoc(a, id, "Priya");
  await openDoc(b, id, "Rahul");
  await typeAtStart(a, "saved ");
  await expect.poll(() => text(b)).toBe("saved ");

  await a.getByTestId("toggle-offline").click();
  await a.getByTestId("editor-content").click();
  await a.keyboard.press("Control+End");
  await a.keyboard.type("draft", { delay: 10 });
  await expect.poll(() => text(a)).toBe("saved draft");
  // Let the IndexedDB write for the last keystroke finish, then reload.
  await a.waitForTimeout(300);
  await a.reload();
  await expect(a.getByTestId("status")).toHaveAttribute("data-status", "online");
  // The unsent "draft" came back from IndexedDB and was delivered on connecting.
  await expect.poll(() => text(a)).toBe("saved draft");
  await expect.poll(() => text(b)).toBe("saved draft");
  await ctx.close();
});

test("remote cursors show up on the right peer and survive edits before them", async ({
  browser,
  request,
}) => {
  const id = await newDoc(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openDoc(a, id, "Priya");
  await openDoc(b, id, "Rahul");
  await typeAtStart(a, "0123456789");
  await expect.poll(() => text(b)).toBe("0123456789");

  // Priya parks her cursor after "5".
  await a.evaluate(() => {
    const w = window as unknown as {
      __rce: { view: { dispatch(s: unknown): void } };
    };
    w.__rce.view.dispatch({ selection: { anchor: 6 } });
  });
  const caret = b.locator('[data-testid="remote-caret"][data-peer="Priya"]');
  await expect(caret).toHaveCount(1);
  await expect.poll(() => around(b)).toBe("012345|6789");

  // Rahul types at the very start: Priya's caret must still sit after "5".
  await typeAtStart(b, "XYZ");
  await expect.poll(() => text(a)).toBe("XYZ0123456789");
  await expect.poll(() => around(b)).toBe("XYZ012345|6789");
  await ctx.close();
});

test("display names are text, never HTML", async ({ browser, request }) => {
  const id = await newDoc(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openDoc(a, id, "Priya");
  await openDoc(b, id, '<img src=x onerror="window.__xss=1">Mallory');
  await typeAtStart(b, "hi");
  await expect.poll(() => text(a)).toBe("hi");
  await expect(a.getByTestId("peer")).toHaveCount(1);
  await expect(a.locator("header img")).toHaveCount(0);
  await expect(a.locator(".cm-peer-label img")).toHaveCount(0);
  expect(await a.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await ctx.close();
});

test("the debug panel shows characters and tombstones", async ({ browser, request }) => {
  const id = await newDoc(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await openDoc(a, id, "Priya");
  await a.getByTestId("toggle-debug").click();
  await typeAtStart(a, "abc");
  await a.keyboard.press("Backspace");
  await expect(a.getByTestId("dbg-length")).toHaveText("2");
  await expect(a.getByTestId("dbg-nodes")).toHaveText("3");
  await expect(a.getByTestId("dbg-tombstones")).toHaveText("1");
  await expect(a.locator('[data-testid="debug-panel"] li[data-deleted="true"]')).toHaveCount(1);
  await ctx.close();
});

test("an unknown document is reported, not crashed", async ({ page }) => {
  await page.goto("/doc/00000000-0000-4000-8000-000000000000");
  await expect(page.getByTestId("doc-error")).toContainText("does not exist");
});

test("creating a document from the home page opens it", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("name-input").fill("Nikil");
  await page.getByTestId("new-doc").click();
  await page.waitForURL(/\/doc\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "online");
});
