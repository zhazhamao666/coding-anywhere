import { normalizeMarkdownToPlainText } from "../markdown-text.js";
import type { DesktopCompletionCardInput, PlanTodoItem } from "../types.js";

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
const DEFAULT_RUNNING_PROGRESS_FALLBACK = "桌面端正在继续执行该线程，完成后会在此更新结果。";
const DEFAULT_REMINDER_FALLBACK = "返回飞书继续当前会话。";

export function buildDesktopCompletionCard(
  input: DesktopCompletionCardInput,
): Record<string, unknown> {
  const status = input.status ?? "completed";
  const normalizedInput: DesktopCompletionCardInput = {
    ...input,
    status,
    projectName: truncateCardText(normalizeCardText(input.projectName), MAX_PROJECT_NAME_CHARS),
    threadTitle: truncateCardText(normalizeCardText(input.threadTitle), MAX_THREAD_TITLE_CHARS),
    progressText: input.progressText ? normalizeCardText(input.progressText) : undefined,
    commandCount: input.commandCount ?? 0,
    planTodos: normalizePlanTodos(input.planTodos),
  };
  const summaryLines = normalizeSummaryLines(input.summaryLines ?? []);
  const reminderText = normalizeReminderText(input.reminderText, normalizedInput.threadTitle);
  const progressText = normalizeProgressText(normalizedInput.progressText);
  const card = buildCardPayload({
    input: normalizedInput,
    summaryLines,
    reminderText,
    progressText,
  });
  if (isWithinPayloadBudget(card)) {
    return card;
  }

  const compactCard = buildCardPayload({
    input: normalizedInput,
    summaryLines: normalizeSummaryLines(summaryLines, COMPACT_SUMMARY_MAX_CHARS),
    reminderText: truncateCardText(reminderText, MAX_REMINDER_COMPACT_CHARS),
    progressText: truncateCardText(progressText || DEFAULT_RUNNING_PROGRESS_FALLBACK, 160),
  });
  if (isWithinPayloadBudget(compactCard)) {
    return compactCard;
  }

  return buildCardPayload({
    input: normalizedInput,
    summaryLines: normalizeSummaryLines(summaryLines, MINIMAL_SUMMARY_MAX_CHARS),
    reminderText: truncateCardText(reminderText || DEFAULT_REMINDER_FALLBACK, 80),
    progressText: truncateCardText(progressText || DEFAULT_RUNNING_PROGRESS_FALLBACK, 100),
  });
}

function buildCardPayload(input: {
  input: DesktopCompletionCardInput;
  summaryLines: string[];
  reminderText: string;
  progressText: string;
}): Record<string, unknown> {
  const status = input.input.status ?? "completed";
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
      content: status === "running"
        ? buildProgressMarkdown(input.progressText)
        : buildSummaryMarkdown(input.summaryLines),
    },
    {
      tag: "hr",
    },
    {
      tag: "markdown",
      content: buildReminderMarkdown(input.reminderText),
    },
  ];

  if ((input.input.commandCount ?? 0) > 0) {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "markdown",
      content: `**进度**\n${formatCommandCountText(input.input.commandCount ?? 0)}`,
    });
  }

  if (input.input.planTodos && input.input.planTodos.length > 0) {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "markdown",
      content: buildPlanTodoMarkdown(input.input.planTodos),
    });
  }

  elements.push({
    tag: "hr",
  });
  elements.push({
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
  });

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildCardSummary(input.input, input.summaryLines, input.progressText).slice(0, 120),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: status === "running" ? "桌面任务进行中" : "桌面任务已完成",
      },
      template: status === "running" ? "blue" : "green",
    },
    body: {
      elements,
    },
  };
}

function buildOverviewMarkdown(input: DesktopCompletionCardInput): string {
  const status = input.status ?? "completed";
  const lines = [
    `**${status === "running" ? "桌面任务进行中" : "桌面任务已完成"}**`,
    `**项目**：${input.projectName}`,
    `**线程**：${input.threadTitle}`,
    `**状态**：${status === "running" ? "进行中" : "已完成"}`,
  ];

  if (status === "running") {
    lines.push(`**开始时间**：${formatDateTime(input.startedAt)}`);
  } else {
    lines.push(`**完成时间**：${formatDateTime(input.completedAt)}`);
  }

  return lines.join("\n");
}

function buildSummaryMarkdown(summaryLines: string[]): string {
  return [
    "**Codex 最终返回了什么**",
    ...summaryLines.map(line => `- ${line}`),
  ].join("\n");
}

function buildProgressMarkdown(progressText: string): string {
  return [
    "**当前情况**",
    progressText || DEFAULT_RUNNING_PROGRESS_FALLBACK,
  ].join("\n");
}

function buildReminderMarkdown(reminderText: string): string {
  return [
    "**你最后说了什么**",
    reminderText,
  ].join("\n");
}

function buildPlanTodoMarkdown(items: PlanTodoItem[]): string {
  return [
    "**计划清单**",
    ...items.map(item => `- ${item.completed ? "[x]" : "[ ]"} ${item.text}`),
  ].join("\n");
}

function buildActions(input: DesktopCompletionCardInput): Array<{
  label: string;
  type: "default" | "primary";
  value: Record<string, unknown>;
}> {
  const status = input.status ?? "completed";
  const actions: Array<{
    label: string;
    type: "default" | "primary";
    value: Record<string, unknown>;
  }> = [];

  if (status === "completed") {
    actions.push({
      label: resolvePrimaryActionLabel(input.mode),
      type: "primary",
      value: buildActionValue("continue_desktop_thread", input),
    });
  }

  actions.push({
    label: "查看线程记录",
    type: "default",
    value: buildActionValue("view_desktop_thread_history", input),
  });
  actions.push({
    label: "静音此线程",
    type: "default",
    value: buildActionValue("mute_desktop_thread", input),
  });

  return actions;
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

function normalizePlanTodos(items: PlanTodoItem[] | undefined): PlanTodoItem[] | undefined {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }

  return items
    .map(item => ({
      text: truncateCardText(normalizeCardText(item.text), 140),
      completed: item.completed === true,
    }))
    .filter(item => item.text.length > 0)
    .slice(0, 7);
}

function normalizeProgressText(progressText: string | undefined): string {
  const normalized = progressText ? normalizeCardText(progressText) : "";
  return normalized || DEFAULT_RUNNING_PROGRESS_FALLBACK;
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

function buildCardSummary(
  input: DesktopCompletionCardInput,
  summaryLines: string[],
  progressText: string,
): string {
  return [
    input.projectName,
    input.threadTitle,
    input.status === "running" ? "进行中" : "已完成",
    input.status === "running" ? progressText : summaryLines[0],
  ].join(" · ");
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }

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

function formatCommandCountText(commandCount: number): string {
  return commandCount === 1 ? "Ran 1 command" : `Ran ${commandCount} commands`;
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
