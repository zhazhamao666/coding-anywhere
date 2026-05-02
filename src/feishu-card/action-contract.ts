export type CardSurfaceContext = {
  chatType?: "p2p" | "group";
  chatId?: string;
  surfaceType?: "thread";
  surfaceRef?: string;
};

export type PreferenceBridgeAction =
  | "set_codex_model"
  | "set_reasoning_effort"
  | "set_codex_speed";

export type DesktopThreadBridgeAction =
  | "continue_desktop_thread"
  | "view_desktop_thread_history"
  | "mute_desktop_thread";

export type StableCardBridgeAction =
  | "toggle_plan_mode"
  | "open_diagnostics"
  | "close_diagnostics";

export type CommandActionCallbackMode =
  | "inline_raw_card"
  | "toast_with_raw_card"
  | "async_toast";

export function classifyCommandActionCallbackMode(command: string): CommandActionCallbackMode {
  const parts = command.trim().replace(/\s+/g, " ").split(" ");
  if (parts[0] !== "/ca") {
    return "async_toast";
  }

  const commandName = parts[1] ?? "";
  const subCommand = parts[2] ?? "";
  if (commandName === "new") {
    return "toast_with_raw_card";
  }

  if (
    commandName === "" ||
    commandName === "help" ||
    commandName === "hub" ||
    commandName === "session" ||
    commandName === "status"
  ) {
    return "inline_raw_card";
  }

  if (commandName === "project" && (
    subCommand === "list" ||
    subCommand === "current" ||
    subCommand === "switch"
  )) {
    return "inline_raw_card";
  }

  if (commandName === "thread" && (
    subCommand === "list" ||
    subCommand === "list-current" ||
    subCommand === "switch"
  )) {
    return "inline_raw_card";
  }

  return "async_toast";
}

export function buildCommandActionValue(input: {
  command: string;
  context: CardSurfaceContext;
}): Record<string, unknown> {
  return withSurfaceContext({
    actionKind: "command_action",
    command: input.command,
  }, input.context);
}

export function buildPreferenceActionValue(
  context: CardSurfaceContext,
  bridgeAction: PreferenceBridgeAction,
): Record<string, unknown> {
  return withSurfaceContext({
    actionKind: "preference_action",
    bridgeAction,
  }, context);
}

export function buildPlanModeToggleActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    actionKind: "session_ui_action",
    bridgeAction: "toggle_plan_mode",
  }, context);
}

export function buildOpenDiagnosticsActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    actionKind: "session_ui_action",
    bridgeAction: "open_diagnostics",
  }, context);
}

export function buildCloseDiagnosticsActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    actionKind: "session_ui_action",
    bridgeAction: "close_diagnostics",
  }, context);
}

export function buildPlanChoiceActionValue(input: {
  interactionId: string;
  choiceId: string;
  context: CardSurfaceContext;
}): Record<string, unknown> {
  return withSurfaceContext({
    actionKind: "plan_choice_action",
    bridgeAction: "answer_plan_choice",
    interactionId: input.interactionId,
    choiceId: input.choiceId,
  }, input.context);
}

export function buildDesktopThreadActionValue(
  bridgeAction: DesktopThreadBridgeAction,
  input: CardSurfaceContext & {
    threadId: string;
    mode: "dm" | "project_group" | "thread";
  },
): Record<string, unknown> {
  const chatType = input.chatType ?? (input.mode === "dm" ? "p2p" : "group");
  return withSurfaceContext({
    actionKind: "continue_thread_action",
    bridgeAction,
    threadId: input.threadId,
    mode: input.mode,
  }, {
    chatType,
    ...(chatType === "group" && input.chatId ? { chatId: input.chatId } : {}),
    surfaceType: input.surfaceType,
    surfaceRef: input.surfaceRef,
  });
}

function withSurfaceContext(
  value: Record<string, unknown>,
  context: CardSurfaceContext,
): Record<string, unknown> {
  return {
    ...value,
    ...(context.chatType ? { chatType: context.chatType } : {}),
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.surfaceType ? { surfaceType: context.surfaceType } : {}),
    ...(context.surfaceRef ? { surfaceRef: context.surfaceRef } : {}),
  };
}
