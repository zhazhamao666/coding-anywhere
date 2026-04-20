import { describe, expect, it } from "vitest";

import { buildDesktopCompletionCard } from "../src/feishu-card/desktop-completion-card-builder.js";
import type { DesktopCompletionCardInput } from "../src/types.js";

describe("desktop completion card builder", () => {
  it("builds a dm completion notification card with focused completion details", () => {
    const input: DesktopCompletionCardInput = {
      mode: "dm",
      projectName: "Alpha Project",
      threadTitle: "修复桌面完成通知",
      completedAt: "2026-04-20T10:32:11.000Z",
      summaryLines: [
        "已完成桌面端通知卡的初版实现。",
        "新增定向测试并通过卡片渲染校验。",
      ],
      lastUserHint: "用户希望先收紧通知卡展示，再接回调。",
      threadId: "thread_native_123",
    };
    const card = buildDesktopCompletionCard(input);

    const visibleText = collectVisibleText(card).join("\n");
    const buttons = collectButtons(card);

    expect(card).toMatchObject({
      schema: "2.0",
      config: expect.objectContaining({
        wide_screen_mode: true,
        update_multi: true,
      }),
    });
    expect(visibleText).toContain("桌面任务已完成");
    expect(visibleText).toContain("Alpha Project");
    expect(visibleText).toContain("修复桌面完成通知");
    expect(visibleText).toContain("已完成");
    expect(visibleText).toContain("2026-04-20");
    expect(visibleText).toContain("已完成桌面端通知卡的初版实现。");
    expect(visibleText).toContain("新增定向测试并通过卡片渲染校验。");
    expect(visibleText).toContain("用户希望先收紧通知卡展示，再接回调。");
    expect(visibleText).not.toContain("项目列表");
    expect(visibleText).not.toContain("导航");
    expect(visibleText).not.toContain("当前项目");
    expect(visibleText).not.toContain("thread_native_123");
    expect(buttons.filter(button => button.type === "primary")).toEqual([
      expect.objectContaining({
        label: "在飞书继续",
        value: expect.objectContaining({
          bridgeAction: "continue_desktop_thread",
          threadId: "thread_native_123",
        }),
      }),
    ]);
  });

  it("uses a group-specific primary label and caps actions at one primary plus two secondary buttons", () => {
    const input: DesktopCompletionCardInput = {
      mode: "project_group",
      projectName: "Beta Project",
      threadTitle: "补齐群通知文案",
      completedAt: "2026-04-20T11:00:00.000Z",
      summaryLines: ["群通知版本已准备好，等待接入后续回调。"],
      threadId: "thread_native_group_456",
    };
    const card = buildDesktopCompletionCard(input);

    const buttons = collectButtons(card);
    const primaryButtons = buttons.filter(button => button.type === "primary");

    expect(buttons).toHaveLength(3);
    expect(primaryButtons).toEqual([
      expect.objectContaining({
        label: "在群里开话题继续",
        value: expect.objectContaining({
          bridgeAction: "continue_desktop_thread",
          threadId: "thread_native_group_456",
        }),
      }),
    ]);
    expect(buttons.map(button => button.value?.bridgeAction)).toEqual([
      "continue_desktop_thread",
      "view_desktop_thread_history",
      "mute_desktop_thread",
    ]);
  });

  it("normalizes markdown-heavy multiline input to plain text and truncates summary lines", () => {
    const input: DesktopCompletionCardInput = {
      mode: "dm",
      projectName: "**Alpha**\n# 注入标题",
      threadTitle: "[继续处理](https://example.com/thread)\n- 伪列表",
      completedAt: "2026-04-20T11:10:00.000Z",
      summaryLines: [
        "```\nconst done = true;\n```",
        "**第二条**\n1. 伪步骤",
        "[第三条](https://example.com/three)\n- 伪条目",
        "第四条不该显示",
      ],
      lastUserHint: "请先看 `日志`\n> 然后继续",
      threadId: "thread_native_markdown_789",
    };

    const card = buildDesktopCompletionCard(input);
    const visibleText = collectVisibleText(card).join("\n");
    const serialized = JSON.stringify(card);

    expect(visibleText).toContain("Alpha 注入标题");
    expect(visibleText).toContain("继续处理 (https://example.com/thread) • 伪列表");
    expect(visibleText).toContain("const done = true;");
    expect(visibleText).toContain("第二条 1. 伪步骤");
    expect(visibleText).toContain("第三条 (https://example.com/three) • 伪条目");
    expect(visibleText).toContain("请先看 日志 > 然后继续");
    expect(visibleText).not.toContain("**Alpha**");
    expect(visibleText).not.toContain("# 注入标题");
    expect(visibleText).not.toContain("[继续处理](https://example.com/thread)");
    expect(visibleText).not.toContain("```");
    expect(visibleText).not.toContain("**第二条**");
    expect(visibleText).not.toContain("[第三条](https://example.com/three)");
    expect(visibleText).not.toContain("第四条不该显示");
    expect(serialized).not.toContain("**Alpha**");
    expect(serialized).not.toContain("[继续处理](https://example.com/thread)");
    expect(serialized).not.toContain("```");
  });
});

function collectVisibleText(node: unknown, parentKey?: string): string[] {
  if (typeof node === "string") {
    return parentKey === "content" ? [node] : [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(item => collectVisibleText(item, parentKey));
  }

  if (!node || typeof node !== "object") {
    return [];
  }

  return Object.entries(node).flatMap(([key, value]) => {
    if (key === "value" || key === "behaviors") {
      return [];
    }
    return collectVisibleText(value, key);
  });
}

function collectButtons(card: Record<string, unknown>): Array<{
  label: string;
  type: string;
  value?: Record<string, unknown>;
}> {
  const buttons: Array<{
    label: string;
    type: string;
    value?: Record<string, unknown>;
  }> = [];

  visit(card);
  return buttons;

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    const candidate = node as {
      tag?: unknown;
      type?: unknown;
      text?: {
        content?: unknown;
      };
      value?: Record<string, unknown>;
    };

    if (candidate.tag === "button") {
      buttons.push({
        label: typeof candidate.text?.content === "string" ? candidate.text.content : "",
        type: typeof candidate.type === "string" ? candidate.type : "default",
        value: candidate.value,
      });
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  }
}
