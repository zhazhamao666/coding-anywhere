import { formatPlanModeStateLabel } from "../runtime-status-labels.js";
import {
  buildCloseDiagnosticsActionValue,
  buildOpenDiagnosticsActionValue,
  buildPlanModeToggleActionValue,
  type CardSurfaceContext,
} from "./action-contract.js";
import {
  buildFeishuCardElementsFromSections,
  buildFeishuCardFrame,
  type DiagnosticViewModel,
  type PlanModeState,
  type StableCardMode,
} from "./frame-builder.js";

type StableActionId = "new_session" | "switch_thread" | "more_info";

type BridgeHubAction =
  | {
      id: "more_info";
      label: string;
      value?: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }
  | {
      id?: StableActionId | (string & {});
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    };

function isNonEmptyActionValue(value: Record<string, unknown> | null | undefined): value is Record<string, unknown> {
  return Boolean(value && Object.keys(value).length > 0);
}

function pickPrimaryButton<T extends { type?: "default" | "primary" | "danger" }>(
  buttons: T[],
): T | undefined {
  if (buttons.length === 0) {
    return undefined;
  }

  return buttons.find(button => button.type === "primary") ?? buttons[0];
}

function orderStableActions(input: Array<{ id?: string }>): Array<{ id?: string }> {
  const wantedOrder: StableActionId[] = ["new_session", "switch_thread", "more_info"];
  const remaining = [...input];
  const ordered: Array<{ id?: string }> = [];

  for (const id of wantedOrder) {
    const index = remaining.findIndex(action => action.id === id);
    if (index < 0) {
      continue;
    }

    const [picked] = remaining.splice(index, 1);
    if (picked) {
      ordered.push(picked);
    }
  }

  ordered.push(...remaining);
  return ordered;
}

export function buildBridgeHubCard(input: {
  title?: string;
  summaryLines: string[];
  stableMode?: StableCardMode;
  planModeState?: PlanModeState;
  context?: CardSurfaceContext;
  diagnostics?: DiagnosticViewModel;
  sections: Array<{
    title: string;
    items: string[];
    monospace?: boolean;
  }>;
  extraElements?: Array<Record<string, unknown>>;
  rows?: Array<{
    title: string;
    lines?: string[];
    buttonLabel?: string;
    value?: Record<string, unknown>;
    type?: "default" | "primary" | "danger";
    buttons?: Array<{
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }>;
  }>;
  actions?: BridgeHubAction[];
}): Record<string, unknown> {
  const summaryGroup: Array<Record<string, unknown>> = [{
    tag: "markdown",
    content: input.summaryLines.join("\n"),
  }];

  const context = input.context;

  if (input.diagnostics && context) {
    const diagnostics = input.diagnostics;
    const diagnosticGroups: Array<Array<Record<string, unknown>>> = [
      summaryGroup,
      [{
        tag: "markdown",
        content: ["**上下文**", ...diagnostics.contextRows.map(row => `- ${row}`)].join("\n"),
      }],
      [{
        tag: "markdown",
        content: ["**最近运行**", ...diagnostics.recentRunRows.map(row => `- ${row}`)].join("\n"),
      }],
      [{
        tag: "markdown",
        content: ["**下一步**", ...diagnostics.nextRunRows.map(row => `- ${row}`)].join("\n"),
      }],
      [{
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
              content: "返回当前会话",
            },
            type: "primary",
            value: buildCloseDiagnosticsActionValue(context),
          }],
        }],
      }],
    ];

    return buildFeishuCardFrame({
      title: input.title ?? "诊断",
      template: "blue",
      summary: input.summaryLines.join(" "),
      elements: buildFeishuCardElementsFromSections(diagnosticGroups),
    });
  }

  const planModeGroup: Array<Record<string, unknown>> | null =
    input.planModeState && context
      ? [buildPlanModeRow(input.planModeState, context)]
      : null;

  const sectionGroups = input.sections.map(section => [{
    tag: "markdown",
    content: [
      `**${section.title}**`,
      ...section.items.map(item => section.monospace ? `- \`${item}\`` : `- ${item}`),
    ].join("\n"),
  }]);

  const rowsGroup = input.rows && input.rows.length > 0
    ? buildRowsGroup(input.rows)
    : null;

  const extraElementsGroup = input.extraElements && input.extraElements.length > 0
    ? input.extraElements
    : null;

  const normalizedActions = input.actions && input.actions.length > 0
    ? normalizeActionsForMode(input.stableMode, context, input.actions)
    : [];
  const actionsRow = normalizedActions.length > 0
    ? buildActionsRow({ actions: normalizedActions })
    : null;
  const actionsGroup = actionsRow ? [actionsRow] : null;

  const elements = buildFeishuCardElementsFromSections([
    summaryGroup,
    planModeGroup,
    ...sectionGroups,
    rowsGroup,
    extraElementsGroup,
    actionsGroup,
  ]);

  return buildFeishuCardFrame({
    title: input.title ?? "CA Hub",
    template: "blue",
    summary: input.summaryLines.join(" "),
    elements,
  });
}

function buildPlanModeRow(
  state: PlanModeState,
  context: CardSurfaceContext,
): Record<string, unknown> {
  const enabledLabel = formatPlanModeStateLabel(state);
  const toggleLabel = state.enabled ? "关闭" : "开启";

  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 4,
        vertical_align: "center",
        elements: [{
          tag: "markdown",
          content: `**计划模式**：${enabledLabel}`,
        }],
      },
      {
        tag: "column",
        width: "auto",
        weight: 1,
        vertical_align: "center",
        elements: [{
          tag: "button",
          text: {
            tag: "plain_text",
            content: toggleLabel,
          },
          type: "default",
          value: buildPlanModeToggleActionValue(context),
        }],
      },
    ],
  };
}

function buildRowsGroup(
  rows: NonNullable<Parameters<typeof buildBridgeHubCard>[0]["rows"]>,
): Array<Record<string, unknown>> {
  return rows.map(row => {
    const candidates = row.buttons && row.buttons.length > 0
      ? row.buttons
      : row.buttonLabel && row.value
        ? [{
            label: row.buttonLabel,
            value: row.value,
            type: row.type,
          }]
        : [];

    const button = pickPrimaryButton(candidates);

    return {
      tag: "column_set",
      flex_mode: "none",
      background_style: "default",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 4,
          vertical_align: "center",
          elements: [{
            tag: "markdown",
            content: [
              `**${row.title}**`,
              ...(row.lines ?? []),
            ].join("\n"),
          }],
        },
        {
          tag: "column",
          width: "auto",
          weight: 1,
          vertical_align: "center",
          elements: button
            ? [{
                tag: "button",
                text: {
                  tag: "plain_text",
                  content: button.label,
                },
                type: button.type ?? "default",
                value: button.value,
              }]
            : [],
        },
      ],
    };
  });
}

function normalizeActionsForMode(
  stableMode: StableCardMode | undefined,
  context: CardSurfaceContext | undefined,
  actions: BridgeHubAction[],
): BridgeHubAction[] {
  if (stableMode !== "completed") {
    return actions;
  }

  const ordered = orderStableActions(actions as any) as BridgeHubAction[];

  return ordered.map(action => {
    if (action.id !== "more_info" || isNonEmptyActionValue(action.value)) {
      return action;
    }

    if (!context) {
      return action;
    }

    return {
      ...action,
      value: buildOpenDiagnosticsActionValue(context),
    };
  });
}

function buildActionsRow(input: {
  actions: BridgeHubAction[];
}): Record<string, unknown> | null {
  const renderable = input.actions.filter(action => isNonEmptyActionValue(action.value));
  if (renderable.length === 0) {
    return null;
  }

  return {
    tag: "column_set",
    flex_mode: "flow",
    background_style: "default",
    columns: renderable.map(action => ({
      tag: "column",
      width: "auto",
      weight: 1,
      vertical_align: "top",
      elements: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: action.label,
        },
        type: action.type ?? "default",
        value: action.value,
      }],
    })),
  };
}
