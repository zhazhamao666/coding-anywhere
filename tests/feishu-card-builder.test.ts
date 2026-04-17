import { describe, expect, it } from "vitest";

import {
  STREAMING_ELEMENT_ID,
  buildBridgeCard,
  buildPlanModeFormCard,
  buildStreamingCardMarkdown,
  buildStreamingShellCard,
} from "../src/feishu-card/card-builder.js";
import { buildBridgeHubCard as buildNavigationCard } from "../src/feishu-card/navigation-card-builder.js";
import type { ProgressCardState } from "../src/types.js";

describe("feishu card builder", () => {
  it("builds a thinking card with CA status, root and session", () => {
    const card = buildBridgeCard(createState({
      status: "preparing",
      stage: "ensuring_session",
      sessionName: "codex-main",
      preview: "[ca] ensuring session",
    }));

    expect(card).toMatchObject({
      schema: "2.0",
      config: expect.objectContaining({
        wide_screen_mode: true,
        update_multi: true,
      }),
    });
    expect(JSON.stringify(card)).toContain("准备中");
    expect(JSON.stringify(card)).toContain("codex-main");
    expect(JSON.stringify(card)).toContain("main");
  });

  it("adds a stop button to non-terminal streaming cards with the current surface context", () => {
    const card = buildBridgeCard(createState({
      status: "running",
      stage: "text",
      preview: "我先继续整理当前待办。",
      deliveryChatId: "oc_chat_current",
      deliverySurfaceType: "thread",
      deliverySurfaceRef: "omt_current",
    }));

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("停止任务");
    expect(serialized).toContain("\"command\":\"/ca stop\"");
    expect(serialized).toContain("\"chatId\":\"oc_chat_current\"");
    expect(serialized).toContain("\"surfaceType\":\"thread\"");
    expect(serialized).toContain("\"surfaceRef\":\"omt_current\"");
  });

  it("builds a streaming shell card with the CardKit streaming element id and a stop button", () => {
    const card = buildStreamingShellCard(createState({
      status: "running",
      stage: "text",
      preview: "思考中",
      deliveryChatId: "oc_chat_current",
      deliverySurfaceType: "thread",
      deliverySurfaceRef: "omt_current",
    }));
    const serialized = JSON.stringify(card);

    expect(serialized).toContain(STREAMING_ELEMENT_ID);
    expect(serialized).toContain("streaming_mode");
    expect(serialized).toContain("停止任务");
    expect(serialized).toContain("\"command\":\"/ca stop\"");
  });

  it("builds streaming markdown with tool details and strips raw markdown markers from preview text", () => {
    const markdown = buildStreamingCardMarkdown(createState({
      status: "tool_active",
      stage: "tool_call",
      sessionName: "codex-main",
      latestTool: "npm test",
      preview: "**明确待办**\n- 清理旧包",
    }));

    expect(markdown).toContain("工具执行中");
    expect(markdown).toContain("npm test");
    expect(markdown).toContain("codex-main");
    expect(markdown).toContain("明确待办");
    expect(markdown).not.toContain("**明确待办**");
  });

  it("builds a complete card with terminal state and elapsed time", () => {
    const card = buildBridgeCard(createState({
      status: "done",
      stage: "done",
      preview: "任务完成",
      elapsedMs: 4_250,
    }));

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("已完成");
    expect(serialized).toContain("4.3s");
  });

  it("summarizes terminal assistant output in the card and points readers to the final message", () => {
    const card = buildBridgeCard(createState({
      status: "done",
      stage: "done",
      preview: [
        "第一段：任务已经完成。",
        "第二段：我调整了终态卡的展示策略。",
        "第三段：完整回复继续保留在下方消息中。",
        "第四段：这行不应该完整出现在终态卡中。",
      ].join("\n"),
      elapsedMs: 4_250,
    }));

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("完整回复请查看下方消息");
    expect(serialized).toContain("第一段：任务已经完成。");
    expect(serialized).toContain("第二段：我调整了终态卡的展示策略。");
    expect(serialized).toContain("第三段：完整回复继续保留在下方消息中。");
    expect(serialized).not.toContain("第四段：这行不应该完整出现在终态卡中。");
  });

  it("renders structured todo items and plan-choice buttons on bridge cards", () => {
    const card = buildBridgeCard(createState({
      status: "done",
      stage: "done",
      preview: "我先把两条改造路径收敛出来，方便你在飞书里直接选择。",
      planTodos: [
        {
          text: "梳理两种改造路径",
          completed: true,
        },
        {
          text: "等待用户选择下一步",
          completed: false,
        },
      ],
      planInteraction: {
        interactionId: "plan-1",
        runId: "run-1",
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
        threadId: "thread-plan-current",
        sessionName: "thread-plan-current",
        status: "pending",
        selectedChoiceId: null,
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        resolvedAt: null,
        question: "你希望我下一步先做哪件事？",
        choices: [
          {
            choiceId: "architecture",
            label: "先梳理架构",
            description: "只输出改造边界与影响面，不改代码。",
            responseText: "先梳理架构与改造边界，不要直接改代码。",
          },
          {
            choiceId: "tests",
            label: "先补测试",
            description: "优先补齐验证路径和风险防线。",
            responseText: "先补测试和验证路径，不要直接改代码。",
          },
        ],
      },
      deliveryChatId: "oc_chat_current",
      deliverySurfaceType: "thread",
      deliverySurfaceRef: "omt_current",
    }));

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("计划清单");
    expect(serialized).toContain("[x] 梳理两种改造路径");
    expect(serialized).toContain("[ ] 等待用户选择下一步");
    expect(serialized).toContain("计划选择");
    expect(serialized).toContain("先梳理架构");
    expect(serialized).toContain("先补测试");
    expect(serialized).toContain("\"bridgeAction\":\"answer_plan_choice\"");
    expect(serialized).toContain("\"interactionId\":\"plan-1\"");
    expect(serialized).toContain("\"choiceId\":\"architecture\"");
    expect(serialized).toContain("\"surfaceType\":\"thread\"");
    expect(serialized).toContain("\"surfaceRef\":\"omt_current\"");
  });

  it("builds a JSON 2.0 plan-mode form card with a multiline form input", () => {
    const card = buildPlanModeFormCard({
      title: "计划模式",
      context: {
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
      },
    });

    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({
      schema: "2.0",
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "form",
          }),
        ]),
      },
    });
    expect(serialized).toContain("\"tag\":\"input\"");
    expect(serialized).toContain("\"input_type\":\"multiline_text\"");
    expect(serialized).toContain("\"name\":\"plan_prompt\"");
    expect(serialized).toContain("\"required\":true");
    expect(serialized).toContain("\"form_action_type\":\"submit\"");
    expect(serialized).toContain("\"bridgeAction\":\"submit_plan_form\"");
    expect(serialized).toContain("\"command\":\"/ca\"");
  });

  it("builds the navigation hub card in schema 2.0 format", () => {
    const card = buildNavigationCard({
      title: "项目列表",
      summaryLines: ["**Root**：main", "**当前会话**：codex-main"],
      sections: [
        {
          title: "快捷命令",
          items: ["/ca hub", "/ca project current"],
          monospace: true,
        },
      ],
      actions: [
        {
          label: "当前项目",
          value: {
            command: "/ca project current",
          },
        },
      ],
    });

    expect(card).toMatchObject({
      schema: "2.0",
      config: expect.objectContaining({
        wide_screen_mode: true,
        update_multi: true,
      }),
      body: expect.objectContaining({
        elements: expect.any(Array),
      }),
    });
    expect(card).toMatchObject({
      header: {
        title: {
          content: "项目列表",
        },
      },
    });
    expect(JSON.stringify(card)).not.toContain("\"tag\":\"action\"");
    expect(card).toMatchObject({
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "column_set",
            columns: expect.arrayContaining([
              expect.objectContaining({
                tag: "column",
                elements: expect.arrayContaining([
                  expect.objectContaining({
                    tag: "button",
                    value: expect.objectContaining({
                      command: "/ca project current",
                    }),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      },
    });
  });
});

function createState(overrides?: Partial<ProgressCardState>): ProgressCardState {
  return {
    runId: "run-1",
    rootName: "main",
    sessionName: "codex-main",
    status: "queued",
    stage: "received",
    preview: "[ca] queued",
    startedAt: 1_000,
    elapsedMs: 0,
    ...overrides,
  };
}
