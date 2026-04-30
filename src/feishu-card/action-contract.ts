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

export function buildCommandActionValue(input: {
  command: string;
  context: CardSurfaceContext;
}): Record<string, unknown> {
  return withSurfaceContext({
    command: input.command,
  }, input.context);
}

export function buildPreferenceActionValue(
  context: CardSurfaceContext,
  bridgeAction: PreferenceBridgeAction,
): Record<string, unknown> {
  return withSurfaceContext({
    bridgeAction,
  }, context);
}

export function buildPlanFormActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    bridgeAction: "open_plan_form",
  }, context);
}

export function buildPlanSubmitActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    bridgeAction: "submit_plan_form",
  }, context);
}

export function buildPlanModeToggleActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    bridgeAction: "toggle_plan_mode",
  }, context);
}

export function buildOpenDiagnosticsActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    bridgeAction: "open_diagnostics",
  }, context);
}

export function buildCloseDiagnosticsActionValue(context: CardSurfaceContext): Record<string, unknown> {
  return withSurfaceContext({
    bridgeAction: "close_diagnostics",
  }, context);
}

export function buildPlanChoiceActionValue(input: {
  interactionId: string;
  choiceId: string;
  context: CardSurfaceContext;
}): Record<string, unknown> {
  return withSurfaceContext({
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
