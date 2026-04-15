import type { PlanTodoItem, ProgressCardState, ProgressStatus } from "../types.js";

export const STREAMING_ELEMENT_ID = "streaming_content";

export function buildStreamingShellCard(summaryText: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
      summary: {
        content: summaryText,
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: summaryText,
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  };
}

export function buildStreamingCardMarkdown(state: ProgressCardState): string {
  const lines = [
    `**状态**：${formatStatusLabel(state.status)}`,
    `**Root**：${state.rootName}`,
  ];

  if (state.sessionName) {
    lines.push(`**Session**：${state.sessionName}`);
  }
  if (state.latestTool) {
    lines.push(`**最近工具**：${state.latestTool}`);
  }
  lines.push("", formatPreviewForCard(state));

  return lines.join("\n");
}

export function buildBridgeCard(state: ProgressCardState): Record<string, unknown> {
  const content = buildStreamingCardMarkdown(state);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content,
    },
  ];

  if (state.planTodos && state.planTodos.length > 0) {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "markdown",
      content: buildTodoMarkdown(state.planTodos),
    });
  }

  if (state.planInteraction) {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "markdown",
      content: [`**计划选择**`, state.planInteraction.question].join("\n"),
    });
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      background_style: "default",
      columns: state.planInteraction.choices.map(choice => ({
        tag: "column",
        width: "auto",
        weight: 1,
        vertical_align: "top",
        elements: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: choice.label,
            },
            value: {
              bridgeAction: "answer_plan_choice",
              interactionId: state.planInteraction?.interactionId,
              choiceId: choice.choiceId,
              chatId: state.deliveryChatId ?? undefined,
              surfaceType: state.deliverySurfaceType ?? undefined,
              surfaceRef: state.deliverySurfaceRef ?? undefined,
            },
          },
          ...(choice.description
            ? [{
                tag: "markdown",
                content: choice.description,
                text_size: "notation",
              }]
            : []),
        ],
      })),
    });
  }

  if (isTerminalStatus(state.status)) {
    elements.push({
      tag: "markdown",
      content: `**终态**：${formatStatusLabel(state.status)} · **耗时**：${formatElapsed(state.elapsedMs)}`,
      text_size: "notation",
    });
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildCardSummary(state).slice(0, 120),
      },
    },
    body: {
      elements,
    },
  };
}

export function buildPlanModeFormCard(input: {
  title?: string;
  context: {
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  };
}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: "计划模式",
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.title ?? "计划模式",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            "**计划模式**",
            "描述你想先梳理的方案，我会把这次输入包装成 `/plan ...` 并发到当前 Codex 线程。",
          ].join("\n"),
        },
        {
          tag: "form",
          name: "bridge_plan_form",
          elements: [
            {
              tag: "input",
              name: "plan_prompt",
              required: true,
              input_type: "multiline_text",
              rows: 4,
              auto_resize: true,
              label: {
                tag: "plain_text",
                content: "计划请求",
              },
              placeholder: {
                tag: "plain_text",
                content: "例如：帮我先梳理这个仓库的改造方案，不要直接改代码",
              },
            },
            {
              tag: "column_set",
              flex_mode: "flow",
              background_style: "default",
              columns: [
                {
                  tag: "column",
                  width: "auto",
                  weight: 1,
                  vertical_align: "top",
                  elements: [{
                    tag: "button",
                    text: {
                      tag: "plain_text",
                      content: "提交",
                    },
                    type: "primary_filled",
                    form_action_type: "submit",
                    name: "bridge_plan_submit",
                    value: {
                      bridgeAction: "submit_plan_form",
                      chatId: input.context.chatId,
                      surfaceType: input.context.surfaceType,
                      surfaceRef: input.context.surfaceRef,
                    },
                  }],
                },
                {
                  tag: "column",
                  width: "auto",
                  weight: 1,
                  vertical_align: "top",
                  elements: [{
                    tag: "button",
                    text: {
                      tag: "plain_text",
                      content: "清空",
                    },
                    form_action_type: "reset",
                    name: "bridge_plan_reset",
                  }],
                },
              ],
            },
          ],
        },
        {
          tag: "column_set",
          flex_mode: "flow",
          background_style: "default",
          columns: [{
            tag: "column",
            width: "auto",
            weight: 1,
            vertical_align: "top",
            elements: [{
              tag: "button",
              text: {
                tag: "plain_text",
                content: "返回导航",
              },
              value: {
                command: "/ca",
                chatId: input.context.chatId,
                surfaceType: input.context.surfaceType,
                surfaceRef: input.context.surfaceRef,
              },
            }],
          }],
        },
      ],
    },
  };
}

function isTerminalStatus(status: ProgressStatus): boolean {
  return status === "done" || status === "error" || status === "canceled";
}

function formatStatusLabel(status: ProgressStatus): string {
  switch (status) {
    case "queued":
      return "已接收";
    case "preparing":
      return "准备中";
    case "canceling":
      return "停止中";
    case "running":
      return "处理中";
    case "tool_active":
      return "工具执行中";
    case "waiting":
      return "等待中";
    case "done":
      return "已完成";
    case "error":
      return "失败";
    case "canceled":
      return "已停止";
  }
}

function formatElapsed(elapsedMs: number): string {
  const seconds = elapsedMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function buildCardSummary(state: ProgressCardState): string {
  if (state.status === "done") {
    return `${formatStatusLabel(state.status)} - 完整回复请查看下方消息`;
  }

  return `${formatStatusLabel(state.status)} - ${state.preview}`;
}

function formatPreviewForCard(state: ProgressCardState): string {
  if (state.status !== "done") {
    return state.preview;
  }

  const excerpt = summarizeTerminalPreview(state.preview);
  if (!excerpt) {
    return "完整回复请查看下方消息";
  }

  return [
    "**摘要**：",
    excerpt,
    "",
    "**完整回复**：请查看下方消息",
  ].join("\n");
}

function summarizeTerminalPreview(preview: string): string {
  const lines = preview
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (lines.length === 0) {
    return "";
  }

  const excerpt = lines.join("\n");
  if (excerpt.length <= 220) {
    return excerpt;
  }

  return `${excerpt.slice(0, 217)}...`;
}

function buildTodoMarkdown(items: PlanTodoItem[]): string {
  return [
    "**计划清单**",
    ...items.map(item => `- ${item.completed ? "[x]" : "[ ]"} ${item.text}`),
  ].join("\n");
}
