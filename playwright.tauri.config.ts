import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /tauri\..*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  reporter: "list",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
