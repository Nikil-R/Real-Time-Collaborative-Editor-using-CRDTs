/**
 * Generates the README screenshots in docs/images. Skipped in normal runs:
 *   SCREENSHOTS=1 pnpm e2e -g screenshots
 */
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:8100";
const OUT = path.resolve(__dirname, "../../../docs/images");

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate the README images");
test.use({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });

async function boot(page: Page, id: string, name: string, theme: "dark" | "light" = "dark") {
  await page.addInitScript(
    ([n, t]) => {
      localStorage.setItem("rce:name", n!);
      localStorage.setItem("rce:theme", t!);
    },
    [name, theme],
  );
  await page.goto(`/w/${id}`);
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "online");
}

test("screenshots", async ({ browser, request }) => {
  const created = await request.post(`${API}/api/projects`, { data: { name: "Team project" } });
  const project = (await created.json()) as { id: string };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });

  // Landing page
  const landing = await ctx.newPage();
  await landing.addInitScript(() => localStorage.setItem("rce:name", "Nikil"));
  await landing.goto("/");
  await landing.waitForTimeout(600);
  await landing.screenshot({ path: path.join(OUT, "landing.png") });

  // Two people in the same workspace, in different files, with live cursors
  const a = await ctx.newPage();
  await boot(a, project.id, "Priya");
  await a.getByTestId("file-src/app.ts").click();
  await expect(a.getByTestId("tab-src/app.ts")).toHaveAttribute("data-active", "true");
  await a.waitForTimeout(800);
  // A separate browser profile per person, like real users (own localStorage, own name).
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  const b = await ctxB.newPage();
  await boot(b, project.id, "Rahul");
  await b.getByTestId("file-src/app.ts").click();
  await expect(b.getByTestId("tab-src/app.ts")).toHaveAttribute("data-active", "true");
  await a.waitForTimeout(800);

  // Priya types a line, Rahul moves his cursor into the middle of it
  await a.locator('[data-testid="editor-pane"][data-active="true"] [data-testid="editor-content"]').click();
  await a.keyboard.press("Control+End");
  await a.keyboard.type("\n// Priya is typing here", { delay: 20 });
  await b.evaluate(() => {
    const w = window as unknown as {
      __rce: { editors: Map<string, { view: { state: { doc: { length: number } }; dispatch(s: unknown): void } }>; store: { getState(): { activeId: string } } };
    };
    const view = w.__rce.editors.get(w.__rce.store.getState().activeId)!.view;
    view.dispatch({ selection: { anchor: 40, head: 58 } });
  });
  await a.waitForTimeout(1500);
  await a.getByTestId("file-src/stats.py").click();
  await b.getByTestId("file-src/app.ts").click();
  await a.getByTestId("file-src/app.ts").click();
  await a.waitForTimeout(1200);
  await a.screenshot({ path: path.join(OUT, "workspace-dark.png") });

  // Markdown preview and light theme
  await a.getByTestId("file-README.md").click();
  await a.getByTestId("panel-preview").click();
  await a.getByTestId("toggle-theme").click();
  await a.waitForTimeout(800);
  await a.screenshot({ path: path.join(OUT, "workspace-light-preview.png") });

  // Debug view
  await a.getByTestId("toggle-theme").click();
  await a.getByTestId("file-src/app.ts").click();
  await a.getByTestId("panel-debug").click();
  await a.waitForTimeout(800);
  await a.screenshot({ path: path.join(OUT, "workspace-debug.png") });
  await ctxB.close();
  await ctx.close();
});
