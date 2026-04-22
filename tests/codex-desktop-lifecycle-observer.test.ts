import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexDesktopCompletionKey,
  buildCodexDesktopRunKey,
  observeCodexDesktopLifecycle,
} from "../src/codex-desktop-completion-observer.js";

describe("codex desktop lifecycle observer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("extracts running progress from real desktop rollout signals without leaking raw command text", () => {
    const rolloutPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "codex",
      "desktop-lifecycle-running.jsonl",
    );

    const result = observeCodexDesktopLifecycle({
      threadId: "thread-1",
      rolloutPath,
    });

    expect(result.completion).toBeUndefined();
    expect(result.progressSnapshot).toEqual({
      runKey: "thread-1:turn-1",
      startedAt: "2026-04-22T10:00:00.000Z",
      lastEventAt: "2026-04-22T10:00:06.000Z",
      latestPublicMessage: "Task 1 的实现已经过了一轮检查，我现在开始补测试和文档。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: false },
        { text: "Task 3: Sync docs", completed: false },
      ],
      commandCount: 2,
    });
    expect(result.nextOffset).toBe(readFileSync(rolloutPath).byteLength);
    expect(JSON.stringify(result.progressSnapshot)).not.toContain("Get-Content");
    expect(JSON.stringify(result.progressSnapshot)).not.toContain("npm test");
  });

  it("continues an active desktop run across polls and keeps the public snapshot alongside completion", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "desktop-lifecycle-observer-"));
    tempDirs.push(tempDir);
    const rolloutPath = path.join(tempDir, "rollout.jsonl");

    writeFileSync(rolloutPath, [
      buildTaskStartedLine("2026-04-22T10:10:00.000Z", "turn-2"),
      buildAgentMessageLine("2026-04-22T10:10:01.000Z", "我先检查 Task 1 的实现。"),
      buildUpdatePlanLine("2026-04-22T10:10:02.000Z", [
        { step: "Task 1: Review implementation", status: "in_progress" },
        { step: "Task 2: Add tests", status: "pending" },
      ]),
      buildShellCommandLine("2026-04-22T10:10:03.000Z", "Get-Content test_parser.py"),
    ].join("\n") + "\n", "utf8");

    const firstPoll = observeCodexDesktopLifecycle({
      threadId: "thread-2",
      rolloutPath,
    });

    expect(firstPoll.completion).toBeUndefined();
    expect(firstPoll.progressSnapshot).toEqual({
      runKey: "thread-2:turn-2",
      startedAt: "2026-04-22T10:10:00.000Z",
      lastEventAt: "2026-04-22T10:10:03.000Z",
      latestPublicMessage: "我先检查 Task 1 的实现。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: false },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 1,
    });

    appendFileSync(rolloutPath, [
      buildShellCommandLine("2026-04-22T10:10:04.000Z", "npm test -- tests/parser.test.ts"),
      buildAgentMessageLine("2026-04-22T10:10:05.000Z", "Task 1 已经 review 完，我现在补测试。"),
      buildFinalAnswerLine("2026-04-22T10:10:06.000Z", "Task 1 已 review 完，并补好了测试与文档。"),
      buildTaskCompleteLine("2026-04-22T10:10:07.000Z"),
    ].join("\n") + "\n", "utf8");

    const secondPoll = observeCodexDesktopLifecycle({
      threadId: "thread-2",
      rolloutPath,
      offset: firstPoll.nextOffset,
      activeSnapshot: firstPoll.progressSnapshot,
    });

    expect(secondPoll.progressSnapshot).toEqual({
      runKey: "thread-2:turn-2",
      startedAt: "2026-04-22T10:10:00.000Z",
      lastEventAt: "2026-04-22T10:10:07.000Z",
      latestPublicMessage: "Task 1 已经 review 完，我现在补测试。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: false },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 2,
    });
    expect(secondPoll.completion).toEqual({
      threadId: "thread-2",
      completedAt: "2026-04-22T10:10:07.000Z",
      finalAssistantText: "Task 1 已 review 完，并补好了测试与文档。",
      completionKey: buildCodexDesktopCompletionKey(
        "thread-2",
        "2026-04-22T10:10:07.000Z",
        "Task 1 已 review 完，并补好了测试与文档。",
      ),
    });
  });

  it("builds a stable runKey from the turn id when available", () => {
    expect(buildCodexDesktopRunKey("thread-1", "2026-04-22T10:00:00.000Z", "turn-1")).toBe("thread-1:turn-1");
    expect(buildCodexDesktopRunKey("thread-1", "2026-04-22T10:00:00.000Z")).toBe(
      "thread-1:2026-04-22T10:00:00.000Z",
    );
  });
});

function buildTaskStartedLine(timestamp: string, turnId: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
    },
  });
}

function buildAgentMessageLine(timestamp: string, message: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "agent_message",
      message,
      phase: "commentary",
    },
  });
}

function buildUpdatePlanLine(
  timestamp: string,
  plan: Array<{ step: string; status: string }>,
): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({ plan }),
    },
  });
}

function buildShellCommandLine(timestamp: string, command: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell_command",
      arguments: JSON.stringify({ command }),
    },
  });
}

function buildFinalAnswerLine(timestamp: string, text: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{
        type: "output_text",
        text,
      }],
    },
  });
}

function buildTaskCompleteLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "task_complete",
    },
  });
}
