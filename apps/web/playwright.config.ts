import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests: real browsers, the real Next.js app and the real FastAPI
 * server (SQLite file so no Docker is needed). Ports differ from the dev
 * defaults so a running dev environment is not disturbed.
 *
 * Browser: PW_CHANNEL (default "msedge", already installed on Windows). In CI
 * set PW_CHANNEL=chromium after `playwright install chromium`.
 */
const API_PORT = 8100;
const WEB_PORT = 3100;
const channel = process.env.PW_CHANNEL ?? "msedge";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: channel === "chromium" ? undefined : channel,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `uv run uvicorn app.main:app --port ${API_PORT}`,
      cwd: "../../server",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        DATABASE_URL: "sqlite+aiosqlite:///./e2e-test.db",
        ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
        LOG_LEVEL: "warning",
      },
    },
    {
      command: `pnpm exec next build && pnpm exec next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_E2E: "1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
