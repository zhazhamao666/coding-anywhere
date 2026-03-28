import type { ProgressCardState, ProgressStatus } from "../types.js";

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

function isTerminalStatus(status: ProgressStatus): boolean {
  return status === "done" || status === "error" || status === "canceled";
}

function formatStatusLabel(status: ProgressStatus): string {
  switch (status) {
    case "queued":
      return "已接收";
    case "preparing":
      return "准备中";
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
