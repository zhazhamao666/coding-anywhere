import { describe, expect, it } from "vitest";

import {
  STREAMING_ELEMENT_ID,
  buildBridgeCard,
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

  it("builds a streaming shell card with the CardKit streaming element id", () => {
    const card = buildStreamingShellCard("思考中");
    const serialized = JSON.stringify(card);

    expect(serialized).toContain(STREAMING_ELEMENT_ID);
    expect(serialized).toContain("streaming_mode");
  });

  it("builds streaming markdown with tool and preview details", () => {
    const markdown = buildStreamingCardMarkdown(createState({
      status: "tool_active",
      stage: "tool_call",
      sessionName: "codex-main",
      latestTool: "npm test",
      preview: "[ca] tool_call: npm test",
    }));

    expect(markdown).toContain("工具执行中");
    expect(markdown).toContain("npm test");
    expect(markdown).toContain("codex-main");
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
