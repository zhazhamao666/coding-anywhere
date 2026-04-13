import { chromium, expect, test } from "@playwright/test";

import {
  assertFeishuLiveAuthReady,
  createFeishuLiveBrowserLaunchOptions,
} from "../../src/feishu-live-auth.js";
import { loadFeishuLiveTestSettings } from "../../src/feishu-live-test-settings.js";

test("reuses the persistent feishu profile without returning to the login screen", async () => {
  const auth = assertFeishuLiveAuthReady();
  const settings = loadFeishuLiveTestSettings();
  const context = await chromium.launchPersistentContext(
    auth.profileDir,
    createFeishuLiveBrowserLaunchOptions(),
  );

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(settings.dmUrl ?? "https://feishu.cn/messages/", {
      waitUntil: "domcontentloaded",
    });

    await expect(page).toHaveURL(/feishu\.cn\/(?:next\/)?(?:messages|messenger|chat|im)/);
    await expect(page).not.toHaveURL(/login|passport/i);
  } finally {
    await context.close();
  }
});
