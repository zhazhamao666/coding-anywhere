import { normalizeMarkdownToPlainText } from "../markdown-text.js";
import type { DesktopCompletionCardInput } from "../types.js";

const MAX_CARD_PAYLOAD_BYTES = 30 * 1024;
const MAX_PROJECT_NAME_CHARS = 120;
const MAX_THREAD_TITLE_CHARS = 160;
const MAX_REMINDER_CHARS = 260;
const MAX_REMINDER_COMPACT_CHARS = 140;
const SINGLE_PARAGRAPH_SUMMARY_MAX_CHARS = 220;
const MULTI_LINE_SUMMARY_MAX_CHARS = 220;
const COMPACT_SUMMARY_MAX_CHARS = 180;
const MINIMAL_SUMMARY_MAX_CHARS = 120;
const DEFAULT_SUMMARY_FALLBACK = "任务已经在桌面端完成，可继续在飞书追问或查看线程记录。";
const DEFAULT_REMINDER_FALLBACK = "返回飞书继续当前会话。";

export function buildDesktopCompletionCard(
  input: DesktopCompletionCardInput,
): Record<string, unknown> {
  const normalizedInput = {
    ...input,
    projectName: truncateCardText(normalizeCardText(input.projectName), MAX_PROJECT_NAME_CHARS),
    threadTitle: truncateCardText(normalizeCardText(input.threadTitle), MAX_THREAD_TITLE_CHARS),
  };
  const summaryLines = normalizeSummaryLines(input.summaryLines);
  const reminderText = normalizeReminderText(input.reminderText, normalizedInput.threadTitle);
  const card = buildCardPayload({
    input: normalizedInput,
    summaryLines,
    reminderText,
  });
  if (isWithinPayloadBudget(card)) {
    return card;
  }

  const compactCard = buildCardPayload({
    input: normalizedInput,
    summaryLines: normalizeSummaryLines(summaryLines, COMPACT_SUMMARY_MAX_CHARS),
    reminderText: truncateCardText(reminderText, MAX_REMINDER_COMPACT_CHARS),
  });
  if (isWithinPayloadBudget(compactCard)) {
    return compactCard;
  }

  return buildCardPayload({
    input: normalizedInput,
    summaryLines: normalizeSummaryLines(summaryLines, MINIMAL_SUMMARY_MAX_CHARS),
    reminderText: truncateCardText(reminderText || DEFAULT_REMINDER_FALLBACK, 80),
  });
}

function buildCardPayload(input: {
  input: DesktopCompletionCardInput;
  summaryLines: string[];
  reminderText: string;
}): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: buildOverviewMarkdown(input.input),
    },
    {
      tag: "hr",
    },
    {
      tag: "markdown",
      content: buildSummaryMarkdown(input.summaryLines),
    },
    {
      tag: "hr",
    },
    {
      tag: "markdown",
      content: buildReminderMarkdown(input.reminderText),
    },
    {
      tag: "hr",
    },
    {
      tag: "column_set",
      flex_mode: "flow",
      background_style: "default",
      columns: buildActions(input.input).map(action => ({
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
  ];

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildCardSummary(input.input, input.summaryLines).slice(0, 120),
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

function buildReminderMarkdown(reminderText: string): string {
  return [
    "**你离开前的会话**",
    reminderText,
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
      value: buildActionValue("continue_desktop_thread", input),
    },
    {
      label: "查看线程记录",
      type: "default",
      value: buildActionValue("view_desktop_thread_history", input),
    },
    {
      label: "静音此线程",
      type: "default",
      value: buildActionValue("mute_desktop_thread", input),
    },
  ];
}

function resolvePrimaryActionLabel(mode: DesktopCompletionCardInput["mode"]): string {
  switch (mode) {
    case "dm":
    case "thread":
    case "project_group":
      return "在飞书继续";
  }
}

function buildActionValue(
  bridgeAction: "continue_desktop_thread" | "view_desktop_thread_history" | "mute_desktop_thread",
  input: Pick<DesktopCompletionCardInput, "threadId" | "mode" | "chatId" | "surfaceType" | "surfaceRef">,
): Record<string, unknown> {
  return {
    bridgeAction,
    threadId: input.threadId,
    mode: input.mode,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.surfaceType ? { surfaceType: input.surfaceType } : {}),
    ...(input.surfaceRef ? { surfaceRef: input.surfaceRef } : {}),
  };
}

function normalizeSummaryLines(summaryLines: string[], maxChars?: number): string[] {
  const normalized = summaryLines
    .map(line => normalizeCardText(line))
    .filter(line => line.length > 0)
    .slice(0, 3);

  const bounded = boundSummaryLines(
    normalized,
    maxChars ?? (normalized.length <= 1 ? SINGLE_PARAGRAPH_SUMMARY_MAX_CHARS : MULTI_LINE_SUMMARY_MAX_CHARS),
  );

  if (bounded.length > 0) {
    return bounded;
  }

  return [DEFAULT_SUMMARY_FALLBACK];
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

function normalizeReminderText(reminderText: string | undefined, fallback: string): string {
  const normalizedReminder = reminderText ? normalizeCardText(reminderText) : "";
  const normalizedFallback = normalizeCardText(fallback);
  const reminder = normalizedReminder || normalizedFallback || DEFAULT_REMINDER_FALLBACK;
  return truncateCardText(reminder, MAX_REMINDER_CHARS);
}

function truncateCardText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }

  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function isWithinPayloadBudget(card: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(card), "utf8") <= MAX_CARD_PAYLOAD_BYTES;
}
