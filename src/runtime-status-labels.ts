import type { ProgressStage, ProgressStatus } from "./types.js";

export const RUNTIME_STATUS_LABELS: Record<ProgressStatus | "idle", string> = {
  idle: "空闲",
  queued: "已接收",
  preparing: "准备中",
  canceling: "停止中",
  running: "处理中",
  tool_active: "工具执行中",
  waiting: "等待中",
  done: "已完成",
  error: "失败",
  canceled: "已停止",
};

export const RUNTIME_STAGE_LABELS: Record<ProgressStage, string> = {
  received: "已接收",
  resolving_context: "解析上下文",
  ensuring_session: "准备会话",
  session_ready: "会话已就绪",
  submitting_prompt: "提交请求",
  waiting_first_event: "等待首个响应",
  canceling: "停止中",
  tool_call: "工具调用",
  text: "文本响应",
  waiting: "等待中",
  done: "已完成",
  error: "失败",
  canceled: "已停止",
};

export function formatRuntimeStatusLabel(status: ProgressStatus | "idle" | null | undefined): string {
  if (!status) {
    return "-";
  }

  return RUNTIME_STATUS_LABELS[status] ?? status;
}

export function formatRuntimeStageLabel(stage: ProgressStage | null | undefined): string {
  if (!stage) {
    return "-";
  }

  return RUNTIME_STAGE_LABELS[stage] ?? stage;
}

export function formatPlanModeStateLabel(state: { enabled: boolean } | null | undefined): string {
  if (!state) {
    return "-";
  }

  return state.enabled ? "开" : "关";
}
