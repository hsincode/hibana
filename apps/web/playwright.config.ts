import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Every test opens its own page against mocked API routes, so tests in one
  // file can run side by side. Playwright uses half the cores by default; the
  // CI runner has few, so use them all there.
  fullyParallel: true,
  workers: process.env.CI ? "100%" : undefined,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: { command: "bun run dev --host 127.0.0.1", url: "http://127.0.0.1:5173", reuseExistingServer: !process.env.CI },
});
