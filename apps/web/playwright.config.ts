import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Every test opens its own page against mocked API routes, so tests in one
  // file can run side by side. The worker count stays at Playwright's default
  // (half the cores): with one worker per core the CI runner was slow enough
  // for the longest test to hit its 30s timeout (#56).
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: { command: "bun run dev --host 127.0.0.1", url: "http://127.0.0.1:5173", reuseExistingServer: !process.env.CI },
});
