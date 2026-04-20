import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface CodexDesktopCompletionEvent {
  threadId: string;
  completedAt: string;
  finalAssistantText: string;
  completionKey: string;
}

export interface CodexRolloutAppendResult {
  lines: string[];
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
  const fileBuffer = readFileSync(rolloutPath);
  const nextOffset = fileBuffer.byteLength;
  const startOffset = normalizeOffset(offset, nextOffset);
  const appended = fileBuffer.subarray(startOffset).toString("utf8");

  return {
    lines: appended
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean),
    nextOffset,
  };
}

export function extractCodexDesktopCompletion(input: {
  threadId: string;
  lines: string[];
}): CodexDesktopCompletionEvent | undefined {
  let latestFinalAssistantText = "";
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
      latestFinalAssistantText = extractAssistantText(parsed.payload?.content);
      continue;
    }

    if (!isTaskCompleteEvent(parsed)) {
      continue;
    }

    latestCompletion = {
      completedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date(0).toISOString(),
      finalAssistantText: latestFinalAssistantText,
    };
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
  const { lines, nextOffset } = readCodexRolloutAppend(input.rolloutPath, input.offset ?? 0);

  return {
    completion: extractCodexDesktopCompletion({
      threadId: input.threadId,
      lines,
    }),
    nextOffset,
  };
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
