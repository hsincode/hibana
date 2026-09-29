import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: { command: "bun run dev --host 127.0.0.1", url: "http://127.0.0.1:5173", reuseExistingServer: !process.env.CI },
});
