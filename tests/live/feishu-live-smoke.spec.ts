import { chromium, expect, test } from "@playwright/test";

import {
  assertFeishuLiveAuthReady,
  createFeishuLiveBrowserLaunchOptions,
} from "../../src/feishu-live-auth.js";
import { assertFeishuLiveDmConfigured, loadFeishuLiveTestSettings } from "../../src/feishu-live-test-settings.js";

test("opens the bot DM and sends a minimal /ca smoke command", async () => {
  const auth = assertFeishuLiveAuthReady();
  const settings = assertFeishuLiveDmConfigured();
  const smokeText = process.env.FEISHU_LIVE_SMOKE_TEXT ?? "/ca";
  const expectedText = process.env.FEISHU_LIVE_EXPECT_TEXT ?? "导航";
  const conversationName = process.env.FEISHU_LIVE_CONVERSATION_NAME;
  const composerSelector = process.env.FEISHU_LIVE_COMPOSER_SELECTOR ?? "textarea, [contenteditable='true']";
  const context = await chromium.launchPersistentContext(
    auth.profileDir,
    createFeishuLiveBrowserLaunchOptions(),
  );

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(settings.dmUrl, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).not.toHaveURL(/login|passport/i);

    if (conversationName) {
      const conversation = page.getByText(conversationName, { exact: true }).first();
      await expect(conversation).toBeVisible({ timeout: 30_000 });
      await conversation.click();
    }

    const composer = page.locator(composerSelector).last();
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(smokeText);
    await page.keyboard.press("Enter");

    await expect(page.getByText(expectedText, { exact: false }).first()).toBeVisible({
      timeout: 45_000,
    });

    const overviewResponse = await page.request.get(
      new URL("/ops/overview", loadFeishuLiveTestSettings().opsBaseUrl).toString(),
    );
    expect(overviewResponse.ok()).toBe(true);
  } finally {
    await context.close();
  }
});
