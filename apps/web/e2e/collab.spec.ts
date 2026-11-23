import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const API = "http://localhost:8100";

interface Project {
  id: string;
  files: { id: string; name: string }[];
}

async function newProject(request: APIRequestContext): Promise<Project> {
  const res = await request.post(`${API}/api/projects`, { data: { name: "e2e" } });
  expect(res.status()).toBe(201);
  return (await res.json()) as Project;
}

async function addFile(request: APIRequestContext, project: Project, name: string): Promise<void> {
  const res = await request.post(`${API}/api/projects/${project.id}/files`, { data: { name } });
  expect(res.status()).toBe(201);
}

/** The text of the file in the active tab, exactly as CodeMirror holds it. */
function text(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __rce: { activeText(): string } }).__rce.activeText());
}

const ACTIVE_EDITOR = '[data-testid="editor-pane"][data-active="true"] [data-testid="editor-content"]';

async function openWorkspace(page: Page, project: Project, name: string): Promise<void> {
  await page.addInitScript((n) => localStorage.setItem("rce:name", n), name);
  await page.goto(`/w/${project.id}`);
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "online");
}

async function openFile(page: Page, path: string): Promise<void> {
  await page.getByTestId(`file-${path}`).click();
  await expect(page.getByTestId(`tab-${path}`)).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "online");
}

async function typeAtStart(page: Page, s: string): Promise<void> {
  await page.locator(ACTIVE_EDITOR).click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(s, { delay: 15 });
}

async function typeAtEnd(page: Page, s: string): Promise<void> {
  await page.locator(ACTIVE_EDITOR).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(s, { delay: 10 });
}

/** Two people in one browser profile (separate tabs) with one plain-text file open. */
async function twoPeople(
  browser: { newContext(): Promise<BrowserContext> },
  request: APIRequestContext,
  file = "scratch.txt",
) {
  const project = await newProject(request);
  await addFile(request, project, file);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  // Both pages share one localStorage (one browser profile), and each file session reads the
  // display name when it starts, so each person opens their file before the next one loads.
  await openWorkspace(a, project, "Priya");
  await openFile(a, file);
  await openWorkspace(b, project, "Rahul");
  await openFile(b, file);
  return { project, ctx, a, b };
}

test("typing in one window appears in the other", async ({ browser, request }) => {
  const { ctx, a, b } = await twoPeople(browser, request);
  await typeAtStart(a, "Hello from Priya");
  await expect.poll(() => text(b)).toBe("Hello from Priya");
  await ctx.close();
});

test("simultaneous typing at the same spot converges", async ({ browser, request }) => {
  const { ctx, a, b } = await twoPeople(browser, request);
  await Promise.all([typeAtStart(a, "AAAAAAAAAA"), typeAtStart(b, "BBBBBBBBBB")]);
  await expect.poll(async () => (await text(a)).length).toBe(20);
  await expect.poll(async () => (await text(b)).length).toBe(20);
  expect(await text(a)).toBe(await text(b));
  expect([...(await text(a))].sort().join("")).toBe("AAAAAAAAAABBBBBBBBBB");
  await ctx.close();
});

test("offline edits merge after reconnecting; nothing is lost", async ({ browser, request }) => {
  const { ctx, a, b } = await twoPeople(browser, request);
  await typeAtStart(a, "base ");
  await expect.poll(() => text(b)).toBe("base ");

  await b.getByTestId("toggle-offline").click();
  await expect(b.getByTestId("status")).toHaveAttribute("data-status", "offline");
  await expect(b.getByTestId("status")).toContainText("saved locally");

  await typeAtEnd(b, "offline-B");
  await typeAtEnd(a, "online-A");
  await expect(b.getByTestId("outbox")).toContainText("unsent");
  expect(await text(b)).toContain("offline-B");
  expect(await text(a)).not.toContain("offline-B");

  await b.getByTestId("toggle-offline").click();
  await expect(b.getByTestId("status")).toHaveAttribute("data-status", "online");
  await expect.poll(async () => (await text(a)).includes("offline-B")).toBe(true);
  await expect.poll(async () => (await text(b)).includes("online-A")).toBe(true);
  expect(await text(a)).toBe(await text(b));
  await expect(b.getByTestId("outbox")).toHaveCount(0);
  await ctx.close();
});

test("a reload keeps the document and unsent edits, then delivers them", async ({ browser, request }) => {
  const { ctx, a, b } = await twoPeople(browser, request);
  await typeAtStart(a, "saved ");
  await expect.poll(() => text(b)).toBe("saved ");

  await a.getByTestId("toggle-offline").click();
  await typeAtEnd(a, "draft");
  await expect.poll(() => text(a)).toBe("saved draft");
  await a.waitForTimeout(300); // let the IndexedDB write for the last keystroke finish
  await a.reload();
  await expect(a.getByTestId("status")).toHaveAttribute("data-status", "online");
  await openFile(a, "scratch.txt");
  await expect.poll(() => text(a)).toBe("saved draft");
  await expect.poll(() => text(b)).toBe("saved draft");
  await ctx.close();
});

test("remote cursors show the right person and survive edits before them", async ({ browser, request }) => {
  const { ctx, a, b } = await twoPeople(browser, request);
  await typeAtStart(a, "0123456789");
  await expect.poll(() => text(b)).toBe("0123456789");

  await a.evaluate(() => {
    const w = window as unknown as {
      __rce: { editors: Map<string, { view: { dispatch(s: unknown): void } }>; store: { getState(): { activeId: string } } };
    };
    const id = w.__rce.store.getState().activeId;
    w.__rce.editors.get(id)!.view.dispatch({ selection: { anchor: 6 } });
  });
  const around = () =>
    b.evaluate(() => {
      // Both people also have README.md open (hidden), so look only in the active editor.
      const el = document.querySelector(
        '[data-testid="editor-pane"][data-active="true"] [data-peer="Priya"]',
      )!;
      const line = el.closest(".cm-line")!;
      const before = document.createRange();
      before.setStart(line, 0);
      before.setEndBefore(el);
      const after = document.createRange();
      after.setStartAfter(el);
      after.setEnd(line, line.childNodes.length);
      return `${before.toString()}|${after.toString()}`;
    });
  await expect(
    b.locator('[data-testid="editor-pane"][data-active="true"] [data-testid="remote-caret"][data-peer="Priya"]'),
  ).toHaveCount(1);
  await expect.poll(around).toBe("012345|6789");
  await typeAtStart(b, "XYZ");
  await expect.poll(() => text(a)).toBe("XYZ0123456789");
  await expect.poll(around).toBe("XYZ012345|6789");
  await ctx.close();
});

test("display names are text, never HTML", async ({ browser, request }) => {
  const project = await newProject(request);
  await addFile(request, project, "scratch.txt");
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openWorkspace(a, project, "Priya");
  await openFile(a, "scratch.txt");
  await openWorkspace(b, project, '<img src=x onerror="window.__xss=1">Mallory');
  await openFile(b, "scratch.txt");
  await typeAtStart(b, "hi");
  await expect.poll(() => text(a)).toBe("hi");
  await expect(a.getByTestId("peer")).toHaveCount(1);
  await expect(a.locator("header img, aside img, .cm-peer-label img")).toHaveCount(0);
  expect(await a.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await ctx.close();
});

test("the debug panel shows characters and tombstones", async ({ browser, request }) => {
  const project = await newProject(request);
  await addFile(request, project, "scratch.txt");
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await openWorkspace(a, project, "Priya");
  await openFile(a, "scratch.txt");
  await a.getByTestId("panel-debug").click();
  await typeAtStart(a, "abc");
  await a.keyboard.press("Backspace");
  await expect(a.getByTestId("dbg-length")).toHaveText("2");
  await expect(a.getByTestId("dbg-nodes")).toHaveText("3");
  await expect(a.getByTestId("dbg-tombstones")).toHaveText("1");
  await expect(a.locator('[data-testid="debug-panel"] li[data-deleted="true"]')).toHaveCount(1);
  await ctx.close();
});

test("new, renamed and deleted files appear for everyone", async ({ browser, request }) => {
  const { ctx, a, b } = await twoPeople(browser, request);

  await a.getByTestId("new-file").click();
  await a.getByTestId("new-file-input").fill("lib/helpers.py");
  await a.getByTestId("new-file-input").press("Enter");
  await expect(a.getByTestId("tab-lib/helpers.py")).toBeVisible(); // creator opens it
  await expect(b.getByTestId("file-lib/helpers.py")).toBeVisible(); // everyone sees it

  await b.getByTestId("file-row-lib/helpers.py").hover();
  await b.getByTestId("rename-lib/helpers.py").click();
  await b.getByTestId("rename-input").fill("lib/utils.py");
  await b.getByTestId("rename-input").press("Enter");
  await expect(a.getByTestId("file-lib/utils.py")).toBeVisible();
  await expect(a.getByTestId("tab-lib/utils.py")).toBeVisible(); // open tab follows the rename
  await expect(a.getByTestId("file-lib/helpers.py")).toHaveCount(0);

  await a.getByTestId("file-row-lib/utils.py").hover();
  await a.getByTestId("delete-lib/utils.py").click();
  await a.getByTestId("confirm-delete").click();
  await expect(b.getByTestId("file-lib/utils.py")).toHaveCount(0);
  await expect(a.getByTestId("tab-lib/utils.py")).toHaveCount(0); // its tab closes
  await ctx.close();
});

test("a duplicate or invalid file name is refused with a message", async ({ page, request }) => {
  const project = await newProject(request);
  await openWorkspace(page, project, "Priya");
  await page.getByTestId("new-file").click();
  await page.getByTestId("new-file-input").fill("README.md");
  await page.getByTestId("new-file-input").press("Enter");
  await expect(page.getByTestId("file-error")).toContainText("already exists");
  await page.getByTestId("new-file-input").fill("../escape.txt");
  await page.getByTestId("new-file-input").press("Enter");
  await expect(page.getByTestId("file-error")).toBeVisible();
});

test("people see which file each other has open", async ({ browser, request }) => {
  const project = await newProject(request);
  await addFile(request, project, "scratch.txt");
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openWorkspace(a, project, "Priya");
  await openWorkspace(b, project, "Rahul");
  await openFile(b, "scratch.txt");
  const rahul = a.getByTestId("person").filter({ hasText: "Rahul" });
  await expect(rahul).toContainText("scratch.txt");
  await openFile(b, "config.json");
  await expect(rahul).toContainText("config.json");
  await rahul.getByTestId("person-file").click(); // click to follow them
  await expect(a.getByTestId("tab-config.json")).toHaveAttribute("data-active", "true");
  await ctx.close();
});

test("the activity feed shows edits and file changes, merged per person and file", async ({ browser, request }) => {
  const { ctx, a, b } = await twoPeople(browser, request);
  await a.getByTestId("panel-activity").click(); // opened by default; make sure it is shown
  if ((await a.getByTestId("right-panel").count()) === 0) await a.getByTestId("panel-activity").click();
  await typeAtStart(b, "typing something");
  const edit = a.locator('[data-testid="activity-item"][data-kind="edit"]').filter({ hasText: "Rahul" });
  await expect(edit.first()).toContainText("scratch.txt", { timeout: 20_000 });
  await expect(edit).toHaveCount(1); // one entry, not one per keystroke
  await expect(a.getByTestId("activity-list")).toContainText("Rahul");
  await ctx.close();
});

test("starter text is typed in exactly once even when two people open the file together", async ({
  browser,
  request,
}) => {
  const project = await newProject(request);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await Promise.all([openWorkspace(a, project, "Priya"), openWorkspace(b, project, "Rahul")]);
  // README.md is the default tab in both windows.
  await expect.poll(() => text(a), { timeout: 20_000 }).toContain("Welcome to your workspace");
  await expect.poll(() => text(b)).toContain("Welcome to your workspace");
  const final = await text(a);
  expect(final.split("Welcome to your workspace").length - 1).toBe(1);
  expect(await text(b)).toBe(final);
  await ctx.close();
});

test("Markdown preview renders and sanitises hostile content", async ({ browser, request }) => {
  const project = await newProject(request);
  await addFile(request, project, "notes.md");
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await openWorkspace(a, project, "Priya");
  await openFile(a, "notes.md");
  await a.getByTestId("panel-preview").click();
  await typeAtStart(a, "# Big title\n\nSome **bold** text <img src=x onerror=window.__xss=1> done");
  await expect(a.locator('[data-testid="markdown-preview"] h1')).toHaveText("Big title");
  await expect(a.locator('[data-testid="markdown-preview"] strong')).toHaveText("bold");
  await expect(a.locator('[data-testid="markdown-preview"] img')).toHaveCount(0);
  expect(await a.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await ctx.close();
});

test("quick open jumps to a file; language follows the extension", async ({ page, request }) => {
  const project = await newProject(request);
  await openWorkspace(page, project, "Priya");
  await page.keyboard.press("Control+p");
  await page.getByTestId("quick-open-input").fill("stats");
  await expect(page.getByTestId("quick-open-item").first()).toContainText("stats.py");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tab-src/stats.py")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("language")).toHaveText("Python");
  await page.getByTestId("file-src/app.ts").click();
  await expect(page.getByTestId("language")).toHaveText("TypeScript");
  // The syntax highlighter is working: tokens are wrapped in styled spans.
  await expect(page.locator(`${ACTIVE_EDITOR} span[class]`).first()).toBeVisible();
});

test("the theme can be switched and is remembered", async ({ page, request }) => {
  const project = await newProject(request);
  await openWorkspace(page, project, "Priya");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("toggle-theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("an unknown workspace is reported, not crashed", async ({ page }) => {
  await page.goto("/w/00000000-0000-4000-8000-000000000000");
  await expect(page.getByTestId("load-error")).toContainText("does not exist");
  await page.goto("/w/not-a-uuid");
  await expect(page.getByTestId("load-error")).toContainText("not a valid");
});

test("creating a workspace from the home page opens it with the starter files", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("name-input").fill("Nikil");
  await page.getByTestId("project-input").fill("Demo space");
  await page.getByTestId("new-workspace").click();
  await page.waitForURL(/\/w\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("project-name")).toHaveText("Demo space");
  await expect(page.getByTestId("file-src/app.ts")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "online");
});
