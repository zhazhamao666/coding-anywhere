import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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
  const readResult = readCodexRolloutRecords(input.rolloutPath, input.offset ?? 0);
  let pendingFinalAssistant: {
    text: string;
    startOffset: number;
  } | undefined;
  let latestCompletion: {
    completedAt: string;
    finalAssistantText: string;
  } | undefined;

  for (const record of readResult.records) {
    const parsed = parseJsonLine(record.line);
    if (!parsed) {
      continue;
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
    pendingFinalAssistant = undefined;
  }

  const nextOffset = pendingFinalAssistant?.startOffset ?? readResult.nextOffset;

  return {
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

function decodeCodexJsonlLine(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  const endIndex = buffer[buffer.length - 1] === 0x0d ? buffer.length - 1 : buffer.length;
  return buffer.subarray(0, endIndex).toString("utf8").trim();
}
