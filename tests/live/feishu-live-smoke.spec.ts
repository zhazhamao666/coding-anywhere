import { chromium, expect, test, type Page } from "@playwright/test";

import {
  assertFeishuLiveAuthReady,
  createFeishuLiveBrowserLaunchOptions,
} from "../../src/feishu-live-auth.js";
import { buildFeishuLiveJourney, type FeishuLiveJourneyStep } from "../../src/feishu-live-journey.js";
import { assertFeishuLiveTargetConfigured, loadFeishuLiveTestSettings } from "../../src/feishu-live-test-settings.js";

test("walks the main Feishu live UI journey on the configured autotest surface", async () => {
  const auth = assertFeishuLiveAuthReady();
  const settings = assertFeishuLiveTargetConfigured();
  const conversationName = settings.conversationName;
  const composerSelector = process.env.FEISHU_LIVE_COMPOSER_SELECTOR ?? "textarea, [contenteditable='true']";
  const journey = buildFeishuLiveJourney({
    surface: settings.surface,
    projectKey: settings.projectKey,
  });
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

    for (const step of journey.steps) {
      await test.step(step.name, async () => {
        await executeJourneyStep({
          step,
          page,
          sendComposerText,
        });
      });
    }

    if (process.env.FEISHU_LIVE_SMOKE_TEXT) {
      await test.step("执行额外 smoke 指令", async () => {
        await sendComposerText(process.env.FEISHU_LIVE_SMOKE_TEXT as string);
        await expectText(page, [process.env.FEISHU_LIVE_EXPECT_TEXT ?? ""]);
      });
    }

    const overviewResponse = await page.request.get(
      new URL("/ops/overview", loadFeishuLiveTestSettings().opsBaseUrl).toString(),
    );
    expect(overviewResponse.ok()).toBe(true);
  } finally {
    await context.close();
  }
});

async function executeJourneyStep(input: {
  step: FeishuLiveJourneyStep;
  page: Page;
  sendComposerText: (text: string) => Promise<void>;
}): Promise<void> {
  if (input.step.kind === "command") {
    await input.sendComposerText(input.step.text);
  } else {
    const target = input.page.getByText(input.step.label, { exact: true }).last();
    await expect(target).toBeVisible({ timeout: 45_000 });
    await target.click();
  }

  if (input.step.expectText) {
    await expectText(input.page, input.step.expectText);
  }
  if (input.step.expectAnyText) {
    await expectAnyText(input.page, input.step.expectAnyText);
  }
}

async function expectText(
  page: Page,
  texts: string[],
): Promise<void> {
  for (const text of texts.filter(Boolean)) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible({
      timeout: 45_000,
    });
  }
}

async function expectAnyText(
  page: Page,
  texts: string[],
): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 45_000;
  while (Date.now() - startedAt < timeoutMs) {
    for (const text of texts) {
      const visible = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
      if (visible) {
        return;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Expected one of these texts to be visible: ${texts.join(", ")}`);
}
