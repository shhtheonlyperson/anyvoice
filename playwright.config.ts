import { defineConfig, devices } from "@playwright/test";

export const PUBLIC_PORT = Number(process.env.PORT ?? 3107);
export const WORKER_PORT = PUBLIC_PORT + 1;
const baseURL = `http://127.0.0.1:${PUBLIC_PORT}`;

// Stub-mode smoke config: boots the production build (`next build` first) in
// BOTH deployment modes — the public OAuth-gated app and the Bearer-token
// worker — with synthesis stubbed and scratch data dirs, so e2e runs are
// deterministic and never touch real voice data or spawn Python workers.
// Explicit shell env wins over .env/.env.local, so a developer's local worker
// config can't leak in.
const COMMON_ENV = [
  "ANYVOICE_STUB=1",
  "ANYVOICE_ENABLE_LOCAL_VOXCPM=0",
  "ANYVOICE_WORKER_URL=",
  "ANYVOICE_WORKER_TOKEN=e2e-worker-token",
  "ANYVOICE_HOT_WORKER_URL=",
  "ANYVOICE_RUNS_DIR=generated/e2e/runs",
  "ANYVOICE_VOICE_PROFILE_ROOT=generated/e2e/voices",
  "AUTH_SECRET=e2e-secret-not-for-prod",
].join(" ");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `${COMMON_ENV} ANYVOICE_WORKER_MODE= AUTH_URL=http://127.0.0.1:${PUBLIC_PORT} npx next start --port ${PUBLIC_PORT}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `${COMMON_ENV} ANYVOICE_WORKER_MODE=1 AUTH_URL=http://127.0.0.1:${WORKER_PORT} npx next start --port ${WORKER_PORT}`,
      url: `http://127.0.0.1:${WORKER_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
