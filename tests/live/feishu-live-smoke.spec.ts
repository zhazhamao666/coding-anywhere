import { chromium, expect, test } from "@playwright/test";

import {
  assertFeishuLiveAuthReady,
  createFeishuLiveBrowserLaunchOptions,
} from "../../src/feishu-live-auth.js";
import { assertFeishuLiveTargetConfigured, loadFeishuLiveTestSettings } from "../../src/feishu-live-test-settings.js";

test("opens the bot DM and sends a minimal /ca smoke command", async () => {
  const auth = assertFeishuLiveAuthReady();
  const settings = assertFeishuLiveTargetConfigured();
  const smokeText = process.env.FEISHU_LIVE_SMOKE_TEXT ?? "/ca";
  const expectedText = process.env.FEISHU_LIVE_EXPECT_TEXT
    ?? (settings.surface === "group" ? "当前群已绑定项目" : "当前项目已选择");
  const conversationName = settings.conversationName;
  const composerSelector = process.env.FEISHU_LIVE_COMPOSER_SELECTOR ?? "textarea, [contenteditable='true']";
  const context = await chromium.launchPersistentContext(
    auth.profileDir,
    createFeishuLiveBrowserLaunchOptions(),
  );

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(settings.targetUrl, {
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
    const sendComposerText = async (text: string) => {
      await composer.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    };

    if (settings.surface === "dm") {
      await sendComposerText(`/ca project switch ${settings.projectKey}`);
      await expect(page.getByText("当前项目已切换", { exact: false }).first()).toBeVisible({
        timeout: 45_000,
      });
    } else {
      await sendComposerText("/ca project current");
      await expect(page.getByText("当前项目", { exact: false }).first()).toBeVisible({
        timeout: 45_000,
      });
      await expect(page.getByText(settings.projectKey, { exact: false }).first()).toBeVisible({
        timeout: 45_000,
      });
    }

    await sendComposerText(smokeText);

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
