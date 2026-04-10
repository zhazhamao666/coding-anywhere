import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/live",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    headless: false,
  },
  projects: [
    {
      name: "feishu-live",
    },
  ],
});
