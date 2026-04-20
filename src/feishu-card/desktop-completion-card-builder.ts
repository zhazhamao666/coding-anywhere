import { normalizeMarkdownToPlainText } from "../markdown-text.js";
import type { DesktopCompletionCardInput } from "../types.js";

export function buildDesktopCompletionCard(
  input: DesktopCompletionCardInput,
): Record<string, unknown> {
  const normalizedInput = {
    ...input,
    projectName: normalizeCardText(input.projectName),
    threadTitle: normalizeCardText(input.threadTitle),
    lastUserHint: input.lastUserHint ? normalizeCardText(input.lastUserHint) : undefined,
  };
  const summaryLines = normalizeSummaryLines(input.summaryLines);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: buildOverviewMarkdown(normalizedInput),
    },
    {
      tag: "hr",
    },
    {
      tag: "markdown",
      content: buildSummaryMarkdown(summaryLines),
    },
  ];

  if (normalizedInput.lastUserHint) {
    elements.push(
      {
        tag: "hr",
      },
      {
        tag: "markdown",
        content: ["**上次你的意图**", normalizedInput.lastUserHint ?? ""].join("\n"),
      },
    );
  }

  elements.push(
    {
      tag: "hr",
    },
    {
      tag: "column_set",
      flex_mode: "flow",
      background_style: "default",
      columns: buildActions(input).map(action => ({
        tag: "column",
        width: "auto",
        weight: 1,
        vertical_align: "top",
        elements: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: action.label,
            },
            type: action.type,
            value: action.value,
          },
        ],
      })),
    },
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildCardSummary(normalizedInput, summaryLines).slice(0, 120),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: "桌面任务已完成",
      },
      template: "green",
    },
    body: {
      elements,
    },
  };
}

function buildOverviewMarkdown(input: DesktopCompletionCardInput): string {
  return [
    "**桌面任务已完成**",
    `**项目**：${input.projectName}`,
    `**线程**：${input.threadTitle}`,
    "**状态**：已完成",
    `**完成时间**：${formatCompletedAt(input.completedAt)}`,
  ].join("\n");
}

function buildSummaryMarkdown(summaryLines: string[]): string {
  return [
    "**结果摘要**",
    ...summaryLines.map(line => `- ${line}`),
  ].join("\n");
}

function buildActions(input: DesktopCompletionCardInput): Array<{
  label: string;
  type: "default" | "primary";
  value: Record<string, unknown>;
}> {
  return [
    {
      label: resolvePrimaryActionLabel(input.mode),
      type: "primary",
      value: buildActionValue("continue_desktop_thread", input.threadId, input.mode),
    },
    {
      label: "查看线程记录",
      type: "default",
      value: buildActionValue("view_desktop_thread_history", input.threadId, input.mode),
    },
    {
      label: "静音此线程",
      type: "default",
      value: buildActionValue("mute_desktop_thread", input.threadId, input.mode),
    },
  ];
}

function resolvePrimaryActionLabel(mode: DesktopCompletionCardInput["mode"]): string {
  switch (mode) {
    case "dm":
      return "在飞书继续";
    case "thread":
      return "在当前话题继续";
    case "project_group":
      return "在群里开话题继续";
  }
}

function buildActionValue(
  bridgeAction: "continue_desktop_thread" | "view_desktop_thread_history" | "mute_desktop_thread",
  threadId: string,
  mode: DesktopCompletionCardInput["mode"],
): Record<string, unknown> {
  return {
    bridgeAction,
    threadId,
    mode,
  };
}

function normalizeSummaryLines(summaryLines: string[]): string[] {
  const normalized = summaryLines
    .map(line => normalizeCardText(line))
    .filter(line => line.length > 0)
    .slice(0, 3);

  const bounded = boundSummaryLines(
    normalized,
    normalized.length <= 1 ? 80 : 220,
  );

  if (bounded.length > 0) {
    return bounded;
  }

  return ["任务已经在桌面端完成，可继续在飞书追问或查看线程记录。"];
}

function boundSummaryLines(lines: string[], maxChars: number): string[] {
  const bounded: string[] = [];
  let usedChars = 0;

  for (const line of lines) {
    const separatorChars = bounded.length > 0 ? 1 : 0;
    const remainingChars = maxChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      break;
    }

    const nextLine = truncateSummaryLine(line, remainingChars);
    if (!nextLine) {
      break;
    }

    bounded.push(nextLine);
    usedChars += separatorChars + nextLine.length;

    if (nextLine !== line) {
      break;
    }
  }

  return bounded;
}

function truncateSummaryLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) {
    return line;
  }

  if (maxChars <= 3) {
    return line.slice(0, maxChars);
  }

  return `${line.slice(0, maxChars - 3).trimEnd()}...`;
}

function buildCardSummary(input: DesktopCompletionCardInput, summaryLines: string[]): string {
  return [
    input.projectName,
    input.threadTitle,
    "已完成",
    summaryLines[0],
  ].join(" · ");
}

function formatCompletedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return normalizeCardText(value);
  }

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function normalizeCardText(text: string): string {
  return normalizeMarkdownToPlainText(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
