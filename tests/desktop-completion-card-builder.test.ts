import { describe, expect, it } from "vitest";

import { buildDesktopCompletionCard } from "../src/feishu-card/desktop-completion-card-builder.js";
import type { DesktopCompletionCardInput } from "../src/types.js";

describe("desktop completion card builder", () => {
  it("builds a running desktop card with reminder before progress and no standalone command block", () => {
    const input: DesktopCompletionCardInput = {
      mode: "dm",
      status: "running",
      projectName: "Alpha Project",
      threadTitle: "修复桌面进行中卡",
      startedAt: "2026-04-22T12:00:00.000Z",
      reminderText: "先把桌面运行态同步到飞书。",
      progressText: "Task 1 已 review 完，我现在补测试和文档。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 3,
      threadId: "thread_native_running_123",
    };

    const card = buildDesktopCompletionCard(input);
    const visibleText = collectVisibleText(card).join("\n");
    const buttons = collectButtons(card);

    expect(visibleText).toContain("桌面任务进行中");
    expect(visibleText).toContain("Alpha Project");
    expect(visibleText).toContain("修复桌面进行中卡");
    expect(visibleText).toContain("进行中");
    expect(visibleText).toContain("2026-04-22");
    expect(visibleText).toContain("Task 1 已 review 完，我现在补测试和文档。");
    expect(visibleText).toContain("[x] Task 1: Review implementation");
    expect(visibleText).toContain("[ ] Task 2: Add tests");
    expect(visibleText).not.toContain("Ran 3 commands");
    expect(visibleText).not.toContain("**进度**");
    expect(visibleText.indexOf("你最后说了什么")).toBeLessThan(visibleText.indexOf("当前情况"));
    expect(buttons).toEqual([]);
  });

  it("builds a dm completion notification card with reminder before final result and no extra progress chrome", () => {
    const input: DesktopCompletionCardInput = {
      mode: "dm",
      status: "completed",
      projectName: "Alpha Project",
      threadTitle: "修复桌面完成通知",
      completedAt: "2026-04-20T10:32:11.000Z",
      summaryLines: [
        "已完成桌面端通知卡的初版实现。",
        "新增定向测试并通过卡片渲染校验。",
      ],
      reminderText: "用户希望先收紧通知卡展示，再接回调。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: true },
      ],
      commandCount: 4,
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
    expect(visibleText).toContain("你最后说了什么");
    expect(visibleText).not.toContain("Ran 4 commands");
    expect(visibleText).not.toContain("**进度**");
    expect(visibleText).not.toContain("计划清单");
    expect(visibleText.indexOf("你最后说了什么")).toBeLessThan(visibleText.indexOf("Codex 最终返回了什么"));
    expect(visibleText).not.toContain("项目列表");
    expect(visibleText).not.toContain("导航");
    expect(visibleText).not.toContain("当前项目");
    expect(visibleText).not.toContain("thread_native_123");
    expect(buttons).toEqual([
      expect.objectContaining({
        label: "在飞书继续",
        type: "primary",
        value: expect.objectContaining({
          bridgeAction: "continue_desktop_thread",
          threadId: "thread_native_123",
        }),
      }),
    ]);
    expect(buttons[0]?.value).toEqual(
      expect.not.objectContaining({
        chatId: expect.anything(),
        surfaceType: expect.anything(),
        surfaceRef: expect.anything(),
      }),
    );
  });

  it("uses the same Feishu-first primary label for project-group delivery and preserves group context", () => {
    const input: DesktopCompletionCardInput = {
      mode: "project_group",
      status: "completed",
      projectName: "Beta Project",
      threadTitle: "补齐群通知文案",
      completedAt: "2026-04-20T11:00:00.000Z",
      summaryLines: ["群通知版本已准备好，等待接入后续回调。"],
      threadId: "thread_native_group_456",
      chatId: "oc_group_456",
    };
    const card = buildDesktopCompletionCard(input);

    const buttons = collectButtons(card);
    const primaryButtons = buttons.filter(button => button.type === "primary");

    expect(buttons).toHaveLength(1);
    expect(primaryButtons).toEqual([
      expect.objectContaining({
        label: "在飞书继续",
        value: expect.objectContaining({
          bridgeAction: "continue_desktop_thread",
          threadId: "thread_native_group_456",
        }),
      }),
    ]);
    expect(buttons.map(button => button.value)).toEqual([
      expect.objectContaining({
        chatId: "oc_group_456",
      }),
    ]);
  });

  it("uses the same Feishu-first primary label for existing-topic delivery and preserves thread context on all actions", () => {
    const input: DesktopCompletionCardInput = {
      mode: "thread",
      status: "completed",
      projectName: "Gamma Project",
      threadTitle: "沿用现有话题继续",
      completedAt: "2026-04-20T11:05:00.000Z",
      summaryLines: ["已有话题里的完成通知应该提示继续当前话题。"],
      threadId: "thread_native_topic_321",
      chatId: "oc_group_topic_321",
      surfaceType: "thread",
      surfaceRef: "omt_topic_321",
    };

    const card = buildDesktopCompletionCard(input);
    const buttons = collectButtons(card);

    expect(buttons).toEqual([
      expect.objectContaining({
        label: "在飞书继续",
        type: "primary",
        value: expect.objectContaining({
          mode: "thread",
          threadId: "thread_native_topic_321",
          chatId: "oc_group_topic_321",
          surfaceType: "thread",
          surfaceRef: "omt_topic_321",
        }),
      }),
    ]);
  });

  it("normalizes markdown-heavy multiline input to plain text while keeping the final result inline", () => {
    const input: DesktopCompletionCardInput = {
      mode: "dm",
      status: "completed",
      projectName: "**Alpha**\n# 注入标题",
      threadTitle: "[继续处理](https://example.com/thread)\n- 伪列表",
      completedAt: "2026-04-20T11:10:00.000Z",
      resultText: [
        "```\nconst done = true;\n```",
        "**第二条**\n1. 伪步骤",
        "[第三条](https://example.com/three)\n- 伪条目",
        "第四条不该显示",
      ].join("\n"),
      reminderText: "请先看 `日志`\n> 然后继续",
      threadId: "thread_native_markdown_789",
    };

    const card = buildDesktopCompletionCard(input);
    const visibleText = collectVisibleText(card).join("\n");
    const serialized = JSON.stringify(card);

    expect(visibleText).toContain("Alpha 注入标题");
    expect(visibleText).toContain("继续处理 (https://example.com/thread) • 伪列表");
    expect(visibleText).toContain("const done = true;");
    expect(visibleText).toContain("第二条");
    expect(visibleText).toContain("1. 伪步骤");
    expect(visibleText).toContain("第三条 (https://example.com/three)");
    expect(visibleText).toContain("• 伪条目");
    expect(visibleText).toContain("请先看 日志 > 然后继续");
    expect(visibleText).not.toContain("**Alpha**");
    expect(visibleText).not.toContain("# 注入标题");
    expect(visibleText).not.toContain("[继续处理](https://example.com/thread)");
    expect(visibleText).not.toContain("```");
    expect(visibleText).not.toContain("**第二条**");
    expect(visibleText).not.toContain("[第三条](https://example.com/three)");
    expect(visibleText).toContain("第四条不该显示");
    expect(serialized).not.toContain("**Alpha**");
    expect(serialized).not.toContain("[继续处理](https://example.com/thread)");
    expect(serialized).not.toContain("```");
  });

  it("always shows 你离开前的会话 and falls back to the thread title when no recent user reminder exists", () => {
    const input: DesktopCompletionCardInput = {
      mode: "thread",
      status: "completed",
      projectName: "Fallback Project",
      threadTitle: "继续修复桌面通知",
      completedAt: "2026-04-20T11:12:00.000Z",
      summaryLines: ["这张卡应该总是带提醒区。"],
      threadId: "thread_native_fallback_987",
    };

    const card = buildDesktopCompletionCard(input);
    const visibleText = collectVisibleText(card).join("\n");

    expect(visibleText).toContain("你最后说了什么");
    expect(visibleText).toContain("继续修复桌面通知");
    expect(visibleText).not.toContain("上次你的意图");
  });

  it("keeps oversized completion content within the Feishu payload budget", () => {
    const input: DesktopCompletionCardInput = {
      mode: "dm",
      status: "completed",
      projectName: "Budget Project",
      threadTitle: "限制摘要预算",
      completedAt: "2026-04-20T11:15:00.000Z",
      resultText: [
        "这是一个超长摘要，用来验证桌面完成通知卡不会把整段正文完整塞进摘要区域。",
        "它会持续追加很多描述文字，直到明显超过允许的 excerpt 预算。",
        "这里再补充关于通知顺序、提醒区回退和 payload guard 的背景说明，确保单段摘要仍然保留充足上下文。",
        "然后继续补上一段关于线程锚点稳定性和结果正文复用策略的描述，把真正的截断点推到更靠后的位置。",
        "最后再增加一段关于群时间线根卡与首条回复配对关系的说明，用来验证 builder 不会因为预算放宽就丢掉边界控制。",
        "尾段标记可能会因为 payload 限制被截断。",
      ].join("").repeat(20),
      threadId: "thread_native_budget_654",
    };

    const card = buildDesktopCompletionCard(input);
    const summaryMarkdown = collectVisibleText(card).find(text => text.includes("Codex 最终返回了什么")) ?? "";

    expect(summaryMarkdown).toContain("**Codex 最终返回了什么**");
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThanOrEqual(30 * 1024);
  });

  it("keeps oversized reminder text within Feishu payload budget", () => {
    const hugeReminder = "提醒内容很长，需要被稳定截断。".repeat(3_000);
    const input: DesktopCompletionCardInput = {
      mode: "dm",
      status: "completed",
      projectName: "Payload Project",
      threadTitle: "限制卡片体积",
      completedAt: "2026-04-20T11:20:00.000Z",
      summaryLines: ["摘要保持正常长度。"],
      reminderText: hugeReminder,
      threadId: "thread_native_payload_111",
    };

    const card = buildDesktopCompletionCard(input);
    const visibleText = collectVisibleText(card).join("\n");

    expect(visibleText).toContain("你最后说了什么");
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThanOrEqual(30 * 1024);
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
