export interface DesktopCompletionCardInput {
  mode: "dm" | "project_group";
  projectName: string;
  threadTitle: string;
  completedAt: string;
  summaryLines: string[];
  lastUserHint?: string;
  threadId: string;
}

export function buildDesktopCompletionCard(
  input: DesktopCompletionCardInput,
): Record<string, unknown> {
  const summaryLines = normalizeSummaryLines(input.summaryLines);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: buildOverviewMarkdown(input),
    },
    {
      tag: "hr",
    },
    {
      tag: "markdown",
      content: buildSummaryMarkdown(summaryLines),
    },
  ];

  if (input.lastUserHint?.trim()) {
    elements.push(
      {
        tag: "hr",
      },
      {
        tag: "markdown",
        content: ["**上次你的意图**", input.lastUserHint.trim()].join("\n"),
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
        content: buildCardSummary(input, summaryLines).slice(0, 120),
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
      label: input.mode === "dm" ? "在飞书继续" : "在群里开话题继续",
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
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, 3);

  if (normalized.length > 0) {
    return normalized;
  }

  return ["任务已经在桌面端完成，可继续在飞书追问或查看线程记录。"];
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
    return value;
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
