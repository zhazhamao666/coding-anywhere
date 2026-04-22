import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { normalizeMarkdownToPlainText } from "./markdown-text.js";
import type { PlanTodoItem } from "./types.js";

export interface CodexDesktopCompletionEvent {
  threadId: string;
  completedAt: string;
  finalAssistantText: string;
  completionKey: string;
}

export interface CodexDesktopProgressSnapshot {
  runKey: string;
  startedAt: string;
  lastEventAt: string;
  latestPublicMessage?: string;
  planTodos?: PlanTodoItem[];
  commandCount: number;
}

export interface CodexRolloutAppendResult {
  lines: string[];
  nextOffset: number;
}

export interface ObserveCodexDesktopLifecycleResult {
  progressSnapshot: CodexDesktopProgressSnapshot | undefined;
  completion: CodexDesktopCompletionEvent | undefined;
  nextOffset: number;
}

export interface ObserveCodexDesktopCompletionResult {
  completion: CodexDesktopCompletionEvent | undefined;
  nextOffset: number;
}

export function readCodexRolloutAppend(
  rolloutPath: string,
  offset = 0,
): CodexRolloutAppendResult {
  const readResult = readCodexRolloutRecords(rolloutPath, offset);

  return {
    lines: readResult.records.map(record => record.line),
    nextOffset: readResult.nextOffset,
  };
}

export function extractCodexDesktopCompletion(input: {
  threadId: string;
  lines: string[];
}): CodexDesktopCompletionEvent | undefined {
  let pendingFinalAssistantText: string | undefined;
  let latestCompletion: {
    completedAt: string;
    finalAssistantText: string;
  } | undefined;

  for (const line of input.lines) {
    const parsed = parseJsonLine(line);
    if (!parsed) {
      continue;
    }

    if (isFinalAssistantMessage(parsed)) {
      pendingFinalAssistantText = extractAssistantText(parsed.payload?.content);
      continue;
    }

    if (!isTaskCompleteEvent(parsed) || pendingFinalAssistantText === undefined) {
      continue;
    }

    latestCompletion = {
      completedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date(0).toISOString(),
      finalAssistantText: pendingFinalAssistantText,
    };
    pendingFinalAssistantText = undefined;
  }

  if (!latestCompletion) {
    return undefined;
  }

  return {
    threadId: input.threadId,
    completedAt: latestCompletion.completedAt,
    finalAssistantText: latestCompletion.finalAssistantText,
    completionKey: buildCodexDesktopCompletionKey(
      input.threadId,
      latestCompletion.completedAt,
      latestCompletion.finalAssistantText,
    ),
  };
}

export function observeCodexDesktopCompletion(input: {
  threadId: string;
  rolloutPath: string;
  offset?: number;
}): ObserveCodexDesktopCompletionResult {
  const observed = observeCodexDesktopLifecycle(input);

  return {
    completion: observed.completion,
    nextOffset: observed.nextOffset,
  };
}

export function observeCodexDesktopLifecycle(input: {
  threadId: string;
  rolloutPath: string;
  offset?: number;
  activeSnapshot?: CodexDesktopProgressSnapshot;
}): ObserveCodexDesktopLifecycleResult {
  const readResult = readCodexRolloutRecords(input.rolloutPath, input.offset ?? 0);
  let pendingFinalAssistant: {
    text: string;
    startOffset: number;
  } | undefined;
  let progressSnapshot = cloneProgressSnapshot(input.activeSnapshot);
  let latestCompletion: {
    completedAt: string;
    finalAssistantText: string;
  } | undefined;

  for (const record of readResult.records) {
    const parsed = parseJsonLine(record.line);
    if (!parsed) {
      continue;
    }

    if (isTaskStartedEvent(parsed)) {
      const startedAt = resolveRecordTimestamp(parsed);
      progressSnapshot = {
        runKey: buildCodexDesktopRunKey(
          input.threadId,
          startedAt,
          typeof parsed?.payload?.turn_id === "string" ? parsed.payload.turn_id : undefined,
        ),
        startedAt,
        lastEventAt: startedAt,
        commandCount: 0,
      };
      pendingFinalAssistant = undefined;
      continue;
    }

    if (progressSnapshot) {
      const publicMessage = extractPublicProgressMessage(parsed);
      if (publicMessage) {
        progressSnapshot.latestPublicMessage = publicMessage;
        progressSnapshot.lastEventAt = resolveRecordTimestamp(parsed);
      }

      const planTodos = extractPlanTodos(parsed);
      if (planTodos) {
        progressSnapshot.planTodos = planTodos;
        progressSnapshot.lastEventAt = resolveRecordTimestamp(parsed);
      }

      if (isShellCommandFunctionCall(parsed)) {
        progressSnapshot.commandCount += 1;
        progressSnapshot.lastEventAt = resolveRecordTimestamp(parsed);
      }
    }

    if (isFinalAssistantMessage(parsed)) {
      pendingFinalAssistant = {
        text: extractAssistantText(parsed.payload?.content),
        startOffset: record.startOffset,
      };
      continue;
    }

    if (!isTaskCompleteEvent(parsed) || !pendingFinalAssistant) {
      continue;
    }

    latestCompletion = {
      completedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date(0).toISOString(),
      finalAssistantText: pendingFinalAssistant.text,
    };
    if (progressSnapshot) {
      progressSnapshot.lastEventAt = latestCompletion.completedAt;
    }
    pendingFinalAssistant = undefined;
  }

  const nextOffset = pendingFinalAssistant?.startOffset ?? readResult.nextOffset;

  return {
    progressSnapshot,
    completion: latestCompletion
      ? {
          threadId: input.threadId,
          completedAt: latestCompletion.completedAt,
          finalAssistantText: latestCompletion.finalAssistantText,
          completionKey: buildCodexDesktopCompletionKey(
            input.threadId,
            latestCompletion.completedAt,
            latestCompletion.finalAssistantText,
          ),
        }
      : undefined,
    nextOffset,
  };
}

export function buildCodexDesktopRunKey(
  threadId: string,
  startedAt: string,
  turnId?: string,
): string {
  const normalizedTurnId = turnId?.trim();
  if (normalizedTurnId) {
    return `${threadId}:${normalizedTurnId}`;
  }

  return `${threadId}:${startedAt}`;
}

export function buildCodexDesktopCompletionKey(
  threadId: string,
  completedAt: string,
  finalAssistantText: string,
): string {
  const digest = createHash("sha256")
    .update(finalAssistantText ?? "")
    .digest("hex");

  return `${threadId}:${completedAt}:${digest}`;
}

function normalizeOffset(offset: number, maxOffset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) {
    return 0;
  }

  const normalized = Math.trunc(offset);
  return normalized >= maxOffset ? maxOffset : normalized;
}

interface CodexRolloutRecord {
  line: string;
  startOffset: number;
}

function readCodexRolloutRecords(
  rolloutPath: string,
  offset: number,
): {
  records: CodexRolloutRecord[];
  nextOffset: number;
} {
  const fd = openSync(rolloutPath, "r");
  try {
    const { size } = fstatSync(fd);
    const startOffset = normalizeOffset(offset, size);
    if (startOffset >= size) {
      return {
        records: [],
        nextOffset: size,
      };
    }

    const remainingLength = size - startOffset;
    const buffer = Buffer.allocUnsafe(remainingLength);
    readSync(fd, buffer, 0, remainingLength, startOffset);

    const records: CodexRolloutRecord[] = [];
    let lineStartIndex = 0;

    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) {
        continue;
      }

      const line = decodeCodexJsonlLine(buffer.subarray(lineStartIndex, index));
      if (line) {
        records.push({
          line,
          startOffset: startOffset + lineStartIndex,
        });
      }
      lineStartIndex = index + 1;
    }

    const tailBuffer = buffer.subarray(lineStartIndex);
    const tailLine = decodeCodexJsonlLine(tailBuffer);
    const tailStartOffset = startOffset + lineStartIndex;

    if (tailBuffer.length === 0) {
      return {
        records,
        nextOffset: tailStartOffset,
      };
    }

    if (!tailLine) {
      return {
        records,
        nextOffset: size,
      };
    }

    if (parseJsonLine(tailLine) === undefined) {
      return {
        records,
        nextOffset: tailStartOffset,
      };
    }

    records.push({
      line: tailLine,
      startOffset: tailStartOffset,
    });

    return {
      records,
      nextOffset: size,
    };
  } finally {
    closeSync(fd);
  }
}

function parseJsonLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isFinalAssistantMessage(parsed: any): boolean {
  return parsed?.type === "response_item" &&
    parsed?.payload?.type === "message" &&
    parsed?.payload?.role === "assistant" &&
    parsed?.payload?.phase === "final_answer";
}

function isTaskCompleteEvent(parsed: any): boolean {
  return parsed?.type === "event_msg" && parsed?.payload?.type === "task_complete";
}

function isTaskStartedEvent(parsed: any): boolean {
  return parsed?.type === "event_msg" && parsed?.payload?.type === "task_started";
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map(item => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractPublicProgressMessage(parsed: any): string | undefined {
  if (parsed?.type !== "event_msg" || parsed?.payload?.type !== "agent_message") {
    return undefined;
  }

  const message = typeof parsed?.payload?.message === "string" ? parsed.payload.message : "";
  const normalized = normalizeMarkdownToPlainText(message)
    .replace(/\s+/g, " ")
    .trim();

  return normalized || undefined;
}

function extractPlanTodos(parsed: any): PlanTodoItem[] | undefined {
  if (parsed?.type !== "response_item" ||
    parsed?.payload?.type !== "function_call" ||
    parsed?.payload?.name !== "update_plan") {
    return undefined;
  }

  const argumentsPayload = parseFunctionArguments(parsed?.payload?.arguments);
  const plan = Array.isArray(argumentsPayload?.plan) ? argumentsPayload.plan : undefined;
  if (!plan) {
    return undefined;
  }

  return plan
    .map(item => {
      const step = typeof item?.step === "string" ? item.step.trim() : "";
      if (!step) {
        return undefined;
      }

      return {
        text: step,
        completed: typeof item?.status === "string" && item.status === "completed",
      } satisfies PlanTodoItem;
    })
    .filter((item): item is PlanTodoItem => Boolean(item));
}

function isShellCommandFunctionCall(parsed: any): boolean {
  return parsed?.type === "response_item" &&
    parsed?.payload?.type === "function_call" &&
    parsed?.payload?.name === "shell_command";
}

function parseFunctionArguments(argumentsPayload: unknown): any {
  if (typeof argumentsPayload === "string") {
    return parseJsonLine(argumentsPayload);
  }

  if (argumentsPayload && typeof argumentsPayload === "object") {
    return argumentsPayload;
  }

  return undefined;
}

function resolveRecordTimestamp(parsed: any): string {
  return typeof parsed?.timestamp === "string" ? parsed.timestamp : new Date(0).toISOString();
}

function cloneProgressSnapshot(
  snapshot: CodexDesktopProgressSnapshot | undefined,
): CodexDesktopProgressSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  return {
    ...snapshot,
    planTodos: snapshot.planTodos ? snapshot.planTodos.map(item => ({ ...item })) : undefined,
  };
}

function decodeCodexJsonlLine(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  const endIndex = buffer[buffer.length - 1] === 0x0d ? buffer.length - 1 : buffer.length;
  return buffer.subarray(0, endIndex).toString("utf8").trim();
}
