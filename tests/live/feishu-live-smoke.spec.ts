import { chromium, expect, test, type Page } from "@playwright/test";

import {
  assertFeishuLiveAuthReady,
  createFeishuLiveBrowserLaunchOptions,
} from "../../src/feishu-live-auth.js";
import { buildFeishuLiveJourneys, type FeishuLiveJourneyStep } from "../../src/feishu-live-journey.js";
import { assertFeishuLiveTargetConfigured, loadFeishuLiveTestSettings } from "../../src/feishu-live-test-settings.js";

test("walks the main Feishu live UI journey on the configured autotest surface", async () => {
  const auth = assertFeishuLiveAuthReady();
  const settings = assertFeishuLiveTargetConfigured();
  const conversationName = settings.conversationName;
  const composerSelector = process.env.FEISHU_LIVE_COMPOSER_SELECTOR ?? "textarea, [contenteditable='true']";
  const journeys = buildFeishuLiveJourneys({
    surface: settings.surface,
    projectKey: settings.projectKey,
    scenarios: settings.scenarios,
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

    for (const journey of journeys) {
      for (const step of journey.setupSteps) {
        await test.step(`${journey.name} 夹具准备：${step.name}`, async () => {
          await executeJourneyStep({
            step,
            page,
            sendComposerText,
            opsBaseUrl: settings.opsBaseUrl,
          });
        });
      }

      for (const step of journey.steps) {
        await test.step(`${journey.name} 用户旅程：${step.name}`, async () => {
          await executeJourneyStep({
            step,
            page,
            sendComposerText,
            opsBaseUrl: settings.opsBaseUrl,
          });
        });
      }
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
  opsBaseUrl: string;
}): Promise<void> {
  const expectedTexts = input.step.expectText ?? input.step.expectAnyText ?? [];
  const beforeCounts = await countVisibleTexts(input.page, expectedTexts);
  let expectFresh = true;

  if (input.step.kind === "command") {
    await input.sendComposerText(input.step.text);
  } else if (input.step.kind === "click") {
    const target = input.page.getByText(input.step.label, { exact: true }).last();
    await expect(target).toBeVisible({ timeout: 45_000 });
    await target.click();
  } else if (input.step.kind === "click_plan_mode_toggle") {
    expectFresh = await ensurePlanModeToggle(input.page, input.step.target);
  } else {
    await input.page.goto(new URL("/ops/ui", input.opsBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
  }

  if (expectedTexts.length > 0 && expectFresh) {
    await expectFreshText(input.page, expectedTexts, beforeCounts, input.step.timeoutMs);
  }
  if (input.step.expectText) {
    await expectText(input.page, input.step.expectText, input.step.timeoutMs);
  }
  if (input.step.expectAnyText) {
    await expectAnyText(input.page, input.step.expectAnyText, input.step.timeoutMs);
  }
  if (input.step.expectAbsentText) {
    await expectAbsentText(input.page, input.step.expectAbsentText);
  }
}

async function ensurePlanModeToggle(page: Page, targetState: "on" | "off"): Promise<boolean> {
  const wantedLabel = targetState === "on" ? "计划模式 [开]" : "计划模式 [关]";
  const oppositeLabel = targetState === "on" ? "计划模式 [关]" : "计划模式 [开]";
  const latestToggle = await findLatestVisibleExactText(page, [wantedLabel, oppositeLabel]);
  if (!latestToggle) {
    throw new Error("Expected a visible plan mode toggle on the latest Feishu card.");
  }
  if (latestToggle.text === wantedLabel) {
    return false;
  }

  await expect(latestToggle.locator).toBeVisible({ timeout: 45_000 });
  await latestToggle.locator.click();
  return true;
}

async function findLatestVisibleExactText(
  page: Page,
  texts: string[],
): Promise<{ text: string; locator: ReturnType<Page["locator"]> } | null> {
  const candidates: Array<{
    text: string;
    locator: ReturnType<Page["locator"]>;
    y: number;
    index: number;
  }> = [];
  for (const text of texts) {
    const locator = page.getByText(text, { exact: true });
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!await item.isVisible().catch(() => false)) {
        continue;
      }
      const box = await item.boundingBox();
      candidates.push({
        text,
        locator: item,
        y: box?.y ?? 0,
        index,
      });
    }
  }

  return candidates.sort((left, right) => right.y - left.y || right.index - left.index)[0] ?? null;
}

async function countVisibleTexts(
  page: Page,
  texts: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const text of texts.filter(Boolean)) {
    counts.set(text, await countVisibleText(page, text));
  }

  return counts;
}

async function countVisibleText(
  page: Page,
  text: string,
): Promise<number> {
  const locator = page.getByText(text, { exact: false });
  const count = await locator.count();
  let visibleCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      visibleCount += 1;
    }
  }

  return visibleCount;
}

async function expectFreshText(
  page: Page,
  texts: string[],
  beforeCounts: Map<string, number>,
  timeoutMs = 45_000,
): Promise<void> {
  const startedAt = Date.now();
  const expectedTexts = texts.filter(Boolean);

  while (Date.now() - startedAt < timeoutMs) {
    for (const text of expectedTexts) {
      const beforeCount = beforeCounts.get(text) ?? 0;
      const currentCount = await countVisibleText(page, text);
      if (currentCount > beforeCount) {
        return;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Expected fresh text to appear: ${expectedTexts.join(", ")}`);
}

async function expectText(
  page: Page,
  texts: string[],
  timeoutMs = 45_000,
): Promise<void> {
  for (const text of texts.filter(Boolean)) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible({
      timeout: timeoutMs,
    });
  }
}

async function expectAnyText(
  page: Page,
  texts: string[],
  timeoutMs = 45_000,
): Promise<void> {
  const startedAt = Date.now();
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

async function expectAbsentText(
  page: Page,
  texts: string[],
): Promise<void> {
  for (const text of texts.filter(Boolean)) {
    await expect(page.getByText(text, { exact: false }).first()).not.toBeVisible({
      timeout: 3_000,
    });
  }
}
