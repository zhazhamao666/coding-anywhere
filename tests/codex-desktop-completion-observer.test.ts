import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
