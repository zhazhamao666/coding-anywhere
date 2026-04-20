import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCodexDesktopCompletionKey,
  extractCodexDesktopCompletion,
  observeCodexDesktopCompletion,
  readCodexRolloutAppend,
} from "../src/codex-desktop-completion-observer.js";

describe("codex desktop completion observer", () => {
  it("reads only appended JSONL lines from the stored byte offset", () => {
    const rolloutPath = fixturePath("desktop-completion-repeat.jsonl");
    const offset = byteOffsetForLineCount("desktop-completion-repeat.jsonl", 3);

    const result = readCodexRolloutAppend(rolloutPath, offset);

    expect(result).toEqual({
      lines: readFixtureLines("desktop-completion-repeat.jsonl").slice(3),
      nextOffset: readFileSync(rolloutPath).byteLength,
    });
  });

  it("detects task_complete and extracts the latest final assistant message", () => {
    const completion = extractCodexDesktopCompletion({
      threadId: "thread-1",
      lines: readFixtureLines("desktop-completion-single.jsonl"),
    });

    expect(completion).toEqual({
      threadId: "thread-1",
      completedAt: "2026-04-20T10:00:10.000Z",
      finalAssistantText: "done text",
      completionKey: `thread-1:2026-04-20T10:00:10.000Z:${createHash("sha256").update("done text").digest("hex")}`,
    });
  });

  it("returns the latest completion event from a rollout with repeated final answers", () => {
    const rolloutPath = fixturePath("desktop-completion-repeat.jsonl");

    const result = observeCodexDesktopCompletion({
      threadId: "thread-1",
      rolloutPath,
      offset: 0,
    });

    expect(result).toEqual({
      completion: {
        threadId: "thread-1",
        completedAt: "2026-04-20T10:00:40.000Z",
        finalAssistantText: "second done",
        completionKey: `thread-1:2026-04-20T10:00:40.000Z:${createHash("sha256").update("second done").digest("hex")}`,
      },
      nextOffset: readFileSync(rolloutPath).byteLength,
    });
  });

  it("rewinds to preserve the latest final assistant text when task_complete arrives in a later poll", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "desktop-completion-observer-"));
    const rolloutPath = path.join(tempDir, "rollout.jsonl");
    const sessionMetaLine = JSON.stringify({
      timestamp: "2026-04-20T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "thread-1",
        timestamp: "2026-04-20T10:00:00.000Z",
        cwd: "D:\\Repos\\Demo",
        cli_version: "0.116.0",
        source: "desktop",
      },
    });
    const finalAnswerLine = JSON.stringify({
      timestamp: "2026-04-20T10:00:09.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: "done text",
          },
        ],
      },
    });
    const taskCompleteLine = JSON.stringify({
      timestamp: "2026-04-20T10:00:10.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
      },
    });

    try {
      writeFileSync(rolloutPath, `${sessionMetaLine}\n${finalAnswerLine}\n`, "utf8");

      const firstPoll = observeCodexDesktopCompletion({
        threadId: "thread-1",
        rolloutPath,
        offset: 0,
      });

      expect(firstPoll).toEqual({
        completion: undefined,
        nextOffset: Buffer.byteLength(`${sessionMetaLine}\n`, "utf8"),
      });

      appendFileSync(rolloutPath, `${taskCompleteLine}\n`, "utf8");

      const secondPoll = observeCodexDesktopCompletion({
        threadId: "thread-1",
        rolloutPath,
        offset: firstPoll.nextOffset,
      });

      expect(secondPoll).toEqual({
        completion: {
          threadId: "thread-1",
          completedAt: "2026-04-20T10:00:10.000Z",
          finalAssistantText: "done text",
          completionKey: `thread-1:2026-04-20T10:00:10.000Z:${createHash("sha256").update("done text").digest("hex")}`,
        },
        nextOffset: readFileSync(rolloutPath).byteLength,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not advance past a trailing partial JSON line and parses it on the next poll", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "desktop-completion-observer-"));
    const rolloutPath = path.join(tempDir, "rollout.jsonl");
    const sessionMetaLine = JSON.stringify({
      timestamp: "2026-04-20T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "thread-1",
        timestamp: "2026-04-20T10:00:00.000Z",
        cwd: "D:\\Repos\\Demo",
        cli_version: "0.116.0",
        source: "desktop",
      },
    });
    const finalAnswerLine = JSON.stringify({
      timestamp: "2026-04-20T10:00:09.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: "done text",
          },
        ],
      },
    });
    const taskCompleteLine = JSON.stringify({
      timestamp: "2026-04-20T10:00:10.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
      },
    });
    const splitIndex = Math.max(1, Math.floor(finalAnswerLine.length / 2));
    const partialFinalAnswerLine = finalAnswerLine.slice(0, splitIndex);
    const remainingFinalAnswerLine = finalAnswerLine.slice(splitIndex);

    try {
      writeFileSync(rolloutPath, `${sessionMetaLine}\n${partialFinalAnswerLine}`, "utf8");

      const firstPoll = observeCodexDesktopCompletion({
        threadId: "thread-1",
        rolloutPath,
        offset: 0,
      });

      expect(firstPoll).toEqual({
        completion: undefined,
        nextOffset: Buffer.byteLength(`${sessionMetaLine}\n`, "utf8"),
      });

      appendFileSync(rolloutPath, `${remainingFinalAnswerLine}\n${taskCompleteLine}\n`, "utf8");

      const secondPoll = observeCodexDesktopCompletion({
        threadId: "thread-1",
        rolloutPath,
        offset: firstPoll.nextOffset,
      });

      expect(secondPoll).toEqual({
        completion: {
          threadId: "thread-1",
          completedAt: "2026-04-20T10:00:10.000Z",
          finalAssistantText: "done text",
          completionKey: `thread-1:2026-04-20T10:00:10.000Z:${createHash("sha256").update("done text").digest("hex")}`,
        },
        nextOffset: readFileSync(rolloutPath).byteLength,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds a stable completionKey", () => {
    const first = buildCodexDesktopCompletionKey(
      "thread-1",
      "2026-04-20T10:00:10.000Z",
      "done text",
    );
    const second = buildCodexDesktopCompletionKey(
      "thread-1",
      "2026-04-20T10:00:10.000Z",
      "done text",
    );

    expect(first).toBe(second);
    expect(first).toBe(
      `thread-1:2026-04-20T10:00:10.000Z:${createHash("sha256").update("done text").digest("hex")}`,
    );
  });

  it("returns the next offset and emits nothing when no new terminal event exists", () => {
    const rolloutPath = fixturePath("desktop-completion-repeat.jsonl");
    const offset = readFileSync(rolloutPath).byteLength;

    const result = observeCodexDesktopCompletion({
      threadId: "thread-1",
      rolloutPath,
      offset,
    });

    expect(result).toEqual({
      completion: undefined,
      nextOffset: offset,
    });
  });
});

function fixturePath(fileName: string): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "codex",
    fileName,
  );
}

function readFixtureLines(fileName: string): string[] {
  return readFileSync(fixturePath(fileName), "utf8")
    .trim()
    .split(/\r?\n/);
}

function byteOffsetForLineCount(fileName: string, lineCount: number): number {
  if (lineCount <= 0) {
    return 0;
  }

  const selected = readFixtureLines(fileName)
    .slice(0, lineCount)
    .map(line => `${line}\n`)
    .join("");

  return Buffer.byteLength(selected, "utf8");
}
