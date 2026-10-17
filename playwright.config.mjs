import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.E2E_PORT || 4173);
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.mjs$/,
  // One shared in-memory workspace, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 30000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
      testIgnore: /mobile\.spec\.mjs$/,
    },
    { name: "phone", use: { ...devices["Pixel 5"] }, testMatch: /mobile\.spec\.mjs$/ },
  ],
  webServer: {
    command: "node e2e/server.mjs",
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(port) },
  },
});
