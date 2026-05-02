import {
  getCodexModelLabel,
  getCodexReasoningLabel,
  getCodexSpeedLabel,
  getFallbackCodexPreferenceCatalog,
} from "../codex-preferences.js";
import { formatRuntimeStatusLabel as formatStatusLabel } from "../runtime-status-labels.js";
import {
  buildCommandActionValue,
  buildOpenDiagnosticsActionValue,
  buildPlanChoiceActionValue,
  buildPreferenceActionValue,
} from "./action-contract.js";
import { buildFeishuCardFrame } from "./frame-builder.js";
import type { PlanTodoItem, ProgressCardState, ProgressStatus } from "../types.js";
import { normalizeMarkdownToPlainText } from "../markdown-text.js";

export const STREAMING_ELEMENT_ID = "streaming_content";

export function buildStreamingShellCard(state: ProgressCardState): Record<string, unknown> {
  const summaryText = buildStreamingCardMarkdown(state);
  return buildFeishuCardFrame({
    summary: summaryText,
    config: {
      streaming_mode: true,
    },
    elements: [
      {
        tag: "markdown",
        content: summaryText,
        element_id: STREAMING_ELEMENT_ID,
      },
      ...(isTerminalStatus(state.status) ? buildCodexPreferenceControlElements(state) : []),
      ...buildStopButtonElements(state),
    ],
  });
}

export function buildStreamingCardMarkdown(state: ProgressCardState): string {
  const lines = [
    `**状态**：${formatStatusLabel(state.status)}`,
    `**Root**：${state.rootName}`,
  ];

  if (state.sessionName) {
    lines.push(`**当前会话**：${state.sessionName}`);
  }
  const taskSettingsSummary = formatTaskSettingsSummary(state);
  if (taskSettingsSummary) {
    lines.push(
      isTerminalStatus(state.status)
        ? `**${state.status === "done" ? "刚完成任务设置" : "本次任务设置"}**：${taskSettingsSummary}`
        : `**本次任务设置**：${taskSettingsSummary}`,
    );
  }

  if (!isTerminalStatus(state.status)) {
    const progressLines = buildProgressLines(state);
    if (progressLines.length > 0) {
      lines.push("", "**当前进展**", ...progressLines.map(line => `- ${line}`));
    }
  }

  return lines.join("\n");
}

export function buildBridgeCard(state: ProgressCardState): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: buildStreamingCardMarkdown(state),
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
              ...buildPlanChoiceActionValue({
                interactionId: state.planInteraction?.interactionId ?? "",
                choiceId: choice.choiceId,
                context: buildProgressCardSurfaceContext(state),
              }),
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
    elements.push(...buildCodexPreferenceControlElements(state));
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "markdown",
      content: buildTerminalResultMarkdown(state),
    });
    elements.push({
      tag: "markdown",
      content: `**终态**：${formatStatusLabel(state.status)} · **耗时**：${formatElapsed(state.elapsedMs)}`,
      text_size: "notation",
    });
    elements.push(...buildTerminalActionElements(state));
  } else {
    elements.push(...buildStopButtonElements(state));
  }

  return buildFeishuCardFrame({
    summary: buildCardSummary(state),
    elements,
  });
}

function isTerminalStatus(status: ProgressStatus): boolean {
  return status === "done" || status === "error" || status === "canceled";
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
  if (isTerminalStatus(state.status)) {
    const excerpt = summarizeTerminalPreview(normalizeMarkdownToPlainText(state.preview));
    return excerpt
      ? `${formatStatusLabel(state.status)} - ${excerpt.replace(/\s+/g, " ").slice(0, 80)}`
      : `${formatStatusLabel(state.status)} - Codex 最终返回了什么`;
  }

  const progressLines = buildProgressLines(state);
  const firstLine = progressLines[0] ?? normalizeMarkdownToPlainText(state.preview) ?? "";
  return `${formatStatusLabel(state.status)} - ${firstLine}`.trim();
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
    ...items.slice(0, 5).map(item => `- ${item.completed ? "[x]" : "[ ]"} ${item.text}`),
  ].join("\n");
}

function formatCommandCountText(commandCount: number): string {
  return commandCount === 1 ? "Ran 1 command" : `Ran ${commandCount} commands`;
}

function buildTerminalResultMarkdown(state: ProgressCardState): string {
  const normalizedPreview = normalizeMarkdownToPlainText(state.preview);
  const excerpt = summarizeTerminalPreview(normalizedPreview);
  if (!excerpt) {
    return "**Codex 最终返回了什么**\n- 暂无可展示的结果";
  }

  return [
    "**Codex 最终返回了什么**",
    excerpt,
    "",
    "完整结果见下方消息",
  ].join("\n");
}

function formatTaskSettingsSummary(state: ProgressCardState): string {
  if (!state.model && !state.reasoningEffort && !state.speed) {
    return "";
  }

  const model = state.model ? getCodexModelLabel(state.model) : "未设置";
  const reasoning = state.reasoningEffort ? getCodexReasoningLabel(state.reasoningEffort) : "未设置";
  const speed = state.speed ? getCodexSpeedLabel(state.speed) : "未设置";
  return `${model} / ${reasoning} / ${speed}`;
}

function buildProgressLines(state: ProgressCardState): string[] {
  const normalizedPreview = normalizeMarkdownToPlainText(state.preview).trim();
  const commandText = (state.commandCount ?? 0) > 0
    ? formatCommandCountText(state.commandCount ?? 0)
    : "";
  const previewLines = normalizedPreview
    ? normalizedPreview
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
    : [];

  if (!commandText) {
    return previewLines.slice(0, 3);
  }

  if (previewLines.length === 0) {
    return [commandText];
  }

  if (previewLines.length === 1 && previewLines[0] === commandText) {
    return [commandText];
  }

  return [commandText, ...previewLines].slice(0, 3);
}

function buildStopButtonElements(state: ProgressCardState): Array<Record<string, unknown>> {
  if (isTerminalStatus(state.status) || state.status === "canceling") {
    return [];
  }

  const label = state.status === "queued" ? "取消排队" : "停止任务";
  return [
    {
      tag: "hr",
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
            content: label,
          },
          type: "danger",
          value: buildStopActionValue(state),
        }],
      }],
    },
  ];
}

function buildStopActionValue(state: ProgressCardState): Record<string, unknown> {
  return buildCommandActionValue({
    command: "/ca stop",
    context: buildProgressCardSurfaceContext(state),
  });
}

function buildCodexPreferenceControlElements(state: ProgressCardState): Array<Record<string, unknown>> {
  const catalog = getFallbackCodexPreferenceCatalog();
  const modelOptions = state.modelOptions ?? catalog.modelOptions;
  const reasoningEffortOptions = state.reasoningEffortOptions ?? catalog.reasoningEffortOptions;
  const speedOptions = state.speedOptions ?? catalog.speedOptions;

  if (!state.model && !state.reasoningEffort && !state.speed) {
    return [];
  }

  return [
    {
      tag: "hr",
    },
    {
      tag: "markdown",
      content: "**下次任务设置**",
    },
    {
      tag: "column_set",
      flex_mode: "none",
      background_style: "default",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: "**模型**",
            },
            {
              tag: "select_static",
              initial_option: state.model ?? catalog.defaultModel,
              placeholder: {
                tag: "plain_text",
                content: "选择模型",
              },
              options: modelOptions.map(model => ({
                text: {
                  tag: "plain_text",
                  content: getCodexModelLabel(model),
                },
                value: model,
              })),
              behaviors: [{
                type: "callback",
                value: buildPreferenceActionValueForState(state, "set_codex_model"),
              }],
            },
          ],
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: "**推理**",
            },
            {
              tag: "select_static",
              initial_option: state.reasoningEffort ?? catalog.defaultReasoningEffort,
              placeholder: {
                tag: "plain_text",
                content: "选择推理",
              },
              options: reasoningEffortOptions.map(reasoningEffort => ({
                text: {
                  tag: "plain_text",
                  content: getCodexReasoningLabel(reasoningEffort),
                },
                value: reasoningEffort,
              })),
              behaviors: [{
                type: "callback",
                value: buildPreferenceActionValueForState(state, "set_reasoning_effort"),
              }],
            },
          ],
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: "**速度**",
            },
            {
              tag: "select_static",
              initial_option: state.speed ?? catalog.defaultSpeed,
              placeholder: {
                tag: "plain_text",
                content: "选择速度",
              },
              options: speedOptions.map(speed => ({
                text: {
                  tag: "plain_text",
                  content: getCodexSpeedLabel(speed),
                },
                value: speed,
              })),
              behaviors: [{
                type: "callback",
                value: buildPreferenceActionValueForState(state, "set_codex_speed"),
              }],
            },
          ],
        },
      ],
    },
  ];
}

function buildPreferenceActionValueForState(
  state: ProgressCardState,
  bridgeAction: "set_codex_model" | "set_reasoning_effort" | "set_codex_speed",
): Record<string, unknown> {
  return buildPreferenceActionValue({
    ...buildProgressCardSurfaceContext(state),
  }, bridgeAction);
}

function buildTerminalActionElements(state: ProgressCardState): Array<Record<string, unknown>> {
  const context = buildProgressCardSurfaceContext(state);

  return [
    {
      tag: "hr",
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
              content: "新会话",
            },
            type: "primary",
            value: buildCommandActionValue({
              command: "/ca new",
              context,
            }),
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
              content: "切换会话",
            },
            value: buildCommandActionValue({
              command: "/ca thread list-current",
              context,
            }),
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
              content: "更多信息",
            },
            value: buildOpenDiagnosticsActionValue(context),
          }],
        },
      ],
    },
  ];
}

function buildProgressCardSurfaceContext(state: ProgressCardState): {
  chatType?: "p2p" | "group";
  chatId?: string;
  surfaceType?: "thread";
  surfaceRef?: string;
} {
  const chatType = state.deliveryChatType ?? (state.deliveryChatId ? "group" : "p2p");
  return {
    chatType,
    ...(chatType === "group" && state.deliveryChatId ? { chatId: state.deliveryChatId } : {}),
    surfaceType: state.deliverySurfaceType ?? undefined,
    surfaceRef: state.deliverySurfaceRef ?? undefined,
  };
}
