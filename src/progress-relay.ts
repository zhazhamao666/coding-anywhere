import type { BridgeObservableEvent, ProgressCardState } from "./types.js";

export function createProgressCardState(input: {
  runId: string;
  rootName: string;
  sessionName?: string;
  model?: string;
  reasoningEffort?: ProgressCardState["reasoningEffort"];
  speed?: ProgressCardState["speed"];
  modelOptions?: ProgressCardState["modelOptions"];
  reasoningEffortOptions?: ProgressCardState["reasoningEffortOptions"];
  speedOptions?: ProgressCardState["speedOptions"];
  deliveryChatId?: string | null;
  deliverySurfaceType?: "thread" | null;
  deliverySurfaceRef?: string | null;
}): ProgressCardState {
  return {
    runId: input.runId,
    rootName: input.rootName,
    sessionName: input.sessionName,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    speed: input.speed,
    modelOptions: input.modelOptions,
    reasoningEffortOptions: input.reasoningEffortOptions,
    speedOptions: input.speedOptions,
    deliveryChatId: input.deliveryChatId ?? null,
    deliverySurfaceType: input.deliverySurfaceType ?? null,
    deliverySurfaceRef: input.deliverySurfaceRef ?? null,
    status: "queued",
    stage: "received",
    preview: "[ca] received",
    startedAt: Date.now(),
    elapsedMs: 0,
  };
}

export function reduceProgressEvent(
  state: ProgressCardState,
  event: BridgeObservableEvent,
): ProgressCardState {
  const nextElapsedMs = Date.now() - state.startedAt;

  if (event.type === "bridge_lifecycle") {
    switch (event.stage) {
      case "received":
        return {
          ...state,
          stage: "received",
          status: "queued",
          preview: event.content ?? "[ca] received",
          elapsedMs: nextElapsedMs,
        };
      case "resolving_context":
        return {
          ...state,
          stage: "resolving_context",
          status: "preparing",
          preview: event.content ?? "[ca] resolving context",
          elapsedMs: nextElapsedMs,
        };
      case "ensuring_session":
        return {
          ...state,
          stage: "ensuring_session",
          status: "preparing",
          preview: event.content ?? "[ca] ensuring session",
          elapsedMs: nextElapsedMs,
        };
      case "session_ready":
        return {
          ...state,
          stage: "session_ready",
          status: "preparing",
          sessionName: event.sessionName ?? state.sessionName,
          preview: event.content ?? "[ca] session ready",
          elapsedMs: nextElapsedMs,
        };
      case "submitting_prompt":
        return {
          ...state,
          stage: "submitting_prompt",
          status: "preparing",
          preview: event.content ?? "[ca] submitting prompt",
          elapsedMs: nextElapsedMs,
        };
      case "waiting_first_event":
        return {
          ...state,
          stage: "waiting_first_event",
          status: "waiting",
          preview: event.content ?? "[ca] waiting for Codex response",
          elapsedMs: nextElapsedMs,
        };
    }
  }

  switch (event.type) {
    case "tool_call":
      return {
        ...state,
        stage: "tool_call",
        status: "tool_active",
        latestTool: event.toolName,
        preview: `[ca] tool_call: ${event.toolName}`,
        elapsedMs: nextElapsedMs,
      };
    case "text":
      return {
        ...state,
        stage: "text",
        status: "running",
        preview: event.content,
        elapsedMs: nextElapsedMs,
      };
    case "waiting":
      return {
        ...state,
        stage: "waiting",
        status: "waiting",
        preview: event.content ? `[ca] waiting: ${event.content}` : "[ca] waiting",
        planTodos: event.planTodos ?? state.planTodos,
        elapsedMs: nextElapsedMs,
      };
    case "done":
      return {
        ...state,
        stage: "done",
        status: "done",
        preview: event.content ?? "[ca] done",
        elapsedMs: nextElapsedMs,
      };
    case "error":
      return {
        ...state,
        stage: "error",
        status: "error",
        preview: `[ca] error: ${event.content}`,
        elapsedMs: nextElapsedMs,
      };
  }
}
