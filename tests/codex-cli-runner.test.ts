import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

import { CodexCliRunner } from "../src/codex-cli-runner.js";

describe("CodexCliRunner", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("checks codex cli health instead of the legacy acpx binary", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
    });
    const runner = new CodexCliRunner("codex");

    await expect(runner.checkHealth()).resolves.toBe(true);

    expect(execaMock).toHaveBeenCalledWith("codex", ["--version"], {
      reject: false,
    });
  });

  it("does not shell out when ensuring native execution context", async () => {
    const runner = new CodexCliRunner("codex");

    await runner.ensureSession({
      targetKind: "codex_thread",
      threadId: "thread-demo",
      sessionName: "thread-demo",
      cwd: "D:/repo",
    });

    expect(execaMock).not.toHaveBeenCalled();
  });

  it("creates a native thread through codex exec and returns the thread id", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "D:/repo",
      stderr: "",
    });
    const child = createChildFromFixture("create-thread.jsonl", 0);
    execaMock.mockReturnValueOnce(child);

    const runner = new CodexCliRunner("codex");
    const seenEvents: unknown[] = [];

    const outcome = await runner.createThread(
      {
        cwd: "D:/repo",
        prompt: "Initialize a bridge thread.",
      },
      event => {
        seenEvents.push(event);
      },
    );

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: "D:/repo",
        reject: false,
      },
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "codex",
      ["exec", "--json", "-"],
      {
        cwd: "D:/repo",
        input: "Initialize a bridge thread.",
        reject: false,
      },
    );
    expect(outcome.threadId).toBe("019d34e0-254e-70f1-9dd5-097fb862d391");
    expect(seenEvents).toEqual([
      expect.objectContaining({
        type: "tool_call",
        toolName: expect.stringContaining("Get-Content"),
        content: expect.stringContaining("Get-Content"),
      }),
      { type: "text", content: "OK" },
      { type: "done", content: "OK" },
    ]);
  });

  it("forwards staged images to codex exec when creating a native thread", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "D:/repo",
      stderr: "",
    });
    const child = createChildFromFixture("create-thread.jsonl", 0);
    execaMock.mockReturnValueOnce(child);

    const runner = new CodexCliRunner("codex");

    await runner.createThread({
      cwd: "D:/repo",
      prompt: "Initialize a bridge thread.",
      images: [
        "D:/assets/one.png",
        "D:/assets/two.png",
      ],
    });

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: "D:/repo",
        reject: false,
      },
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "codex",
      ["exec", "--json", "-i", "D:/assets/one.png", "-i", "D:/assets/two.png", "-"],
      {
        cwd: "D:/repo",
        input: "Initialize a bridge thread.",
        reject: false,
      },
    );
  });

  it("fails createThread early with a readable error when cwd is not a git repository", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
    });

    const runner = new CodexCliRunner("codex");

    await expect(runner.createThread({
      cwd: "D:/not-a-repo",
      prompt: "Initialize a bridge thread.",
    })).rejects.toThrow("当前路径不是 Git 仓库");

    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("treats close as a no-op for native-only execution", async () => {
    const runner = new CodexCliRunner("codex");

    await runner.close({
      targetKind: "codex_thread",
      threadId: "thread-demo",
      sessionName: "thread-demo",
      cwd: "D:/repo",
    });

    expect(execaMock).not.toHaveBeenCalled();
  });

  it("cancels an active native run by killing the tracked child process", async () => {
    let resolveChild: ((value: { exitCode: number | undefined; signal?: string }) => void) | undefined;
    const child = Object.assign(
      new Promise<{ exitCode: number | undefined; signal?: string }>(resolve => {
        resolveChild = resolve;
      }),
      {
        stdout: Readable.from([]),
        kill: vi.fn(() => {
          resolveChild?.({
            exitCode: undefined,
            signal: "SIGTERM",
          });
          return true;
        }),
      },
    );
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");
    const runPromise = runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "test",
    );

    await Promise.resolve();
    await runner.cancel({
      targetKind: "codex_thread",
      threadId: "thread-demo",
      sessionName: "thread-demo",
      cwd: "D:/repo",
    });

    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(runPromise).rejects.toThrow("RUN_CANCELED");
  });

  it("resumes an existing native thread and preserves streamed text chunks", async () => {
    const child = createChunkedChildFromFixture(
      "resume-thread.jsonl",
      0,
      [2, 3],
    );
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");
    const seenEvents: unknown[] = [];

    const outcome = await runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "test",
      event => {
        seenEvents.push(event);
      },
    );

    expect(execaMock).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "resume",
        "--json",
        "thread-demo",
        "-",
      ],
      {
        cwd: "D:/repo",
        input: "test",
        reject: false,
      },
    );
    expect(seenEvents).toEqual([
      expect.objectContaining({
        type: "tool_call",
        toolName: expect.stringContaining("git status --short"),
        content: expect.stringContaining("git status --short"),
      }),
      { type: "text", content: "RESUMED" },
      { type: "done", content: "RESUMED" },
    ]);
    expect(outcome.events).toEqual([
      expect.objectContaining({
        type: "tool_call",
        toolName: expect.stringContaining("git status --short"),
        content: expect.stringContaining("git status --short"),
      }),
      { type: "text", content: "RESUMED" },
      { type: "done", content: "RESUMED" },
    ]);
  });

  it("forwards staged images to codex exec resume", async () => {
    const child = createChildFromFixture("resume-thread.jsonl", 0);
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");

    await runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "test",
      {
        images: [
          "D:/assets/one.png",
          "D:/assets/two.png",
        ],
      },
    );

    expect(execaMock).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "resume",
        "--json",
        "-i",
        "D:/assets/one.png",
        "-i",
        "D:/assets/two.png",
        "thread-demo",
        "-",
      ],
      {
        cwd: "D:/repo",
        input: "test",
        reject: false,
      },
    );
  });

  it("reports a failed command execution as an error and still completes the turn", async () => {
    const child = createChildFromFixture("command-failure.jsonl", 1);
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");
    const seenEvents: unknown[] = [];

    const outcome = await runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "test",
      event => {
        seenEvents.push(event);
      },
    );

    expect(seenEvents).toEqual([
      { type: "tool_call", toolName: "npm test", content: "npm test" },
      { type: "error", content: "npm ERR! Test failed" },
      { type: "done", content: undefined },
    ]);
    expect(outcome.events).toEqual([
      { type: "tool_call", toolName: "npm test", content: "npm test" },
      { type: "error", content: "npm ERR! Test failed" },
      { type: "done", content: undefined },
    ]);
  });

  it("surfaces stderr when codex exits non-zero without a structured error event", async () => {
    const child = Object.assign(
      Promise.resolve({
        exitCode: 1,
        stderr: "fatal: model profile missing",
      }),
      {
        stdout: Readable.from([]),
      },
    );
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");

    await expect(runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "test",
    )).rejects.toThrow("fatal: model profile missing");
  });

  it("surfaces native plan-mode todo items as waiting progress and still completes", async () => {
    const child = createChildFromFixture("plan-mode.jsonl", 0);
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");
    const seenEvents: unknown[] = [];

    const outcome = await runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "enter plan mode",
      event => {
        seenEvents.push(event);
      },
    );

    expect(seenEvents).toEqual([
      {
        type: "waiting",
        content: "Ask whether to continue; Wait for user choice",
        planTodos: [
          {
            text: "Ask whether to continue",
            completed: false,
          },
          {
            text: "Wait for user choice",
            completed: false,
          },
        ],
      },
      expect.objectContaining({
        type: "text",
        content: expect.stringContaining("`request_user_input` is unavailable"),
      }),
      expect.objectContaining({
        type: "done",
        content: expect.stringContaining("`request_user_input` is unavailable"),
      }),
    ]);
    expect(outcome.events).toEqual(seenEvents);
  });

  it("surfaces native sub-agent lifecycle calls without losing the final delegated answer", async () => {
    const child = createChildFromFixture("sub-agent.jsonl", 0);
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");
    const seenEvents: unknown[] = [];

    const outcome = await runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "delegate a sub-agent",
      event => {
        seenEvents.push(event);
      },
    );

    expect(seenEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          toolName: expect.stringContaining("spawn_agent"),
          content: expect.stringContaining("spawn_agent"),
        }),
        expect.objectContaining({
          type: "tool_call",
          toolName: expect.stringContaining("wait"),
          content: expect.stringContaining("wait"),
        }),
        {
          type: "text",
          content: "subagent-fixture",
        },
        {
          type: "done",
          content: "subagent-fixture",
        },
      ]),
    );
    expect(outcome.events).toEqual(seenEvents);
  });

  it("extracts bridge-managed plan-choice directives from native assistant text", async () => {
    const child = createChildFromFixture("plan-choice.jsonl", 0);
    execaMock.mockReturnValue(child);

    const runner = new CodexCliRunner("codex");
    const seenEvents: unknown[] = [];

    const outcome = await runner.submitVerbatim(
      {
        targetKind: "codex_thread",
        threadId: "thread-demo",
        sessionName: "thread-demo",
        cwd: "D:/repo",
      },
      "/plan 梳理方案",
      event => {
        seenEvents.push(event);
      },
    );

    expect(seenEvents).toEqual([
      {
        type: "waiting",
        content: "梳理两种改造路径; 等待用户选择下一步",
        planTodos: [
          {
            text: "梳理两种改造路径",
            completed: true,
          },
          {
            text: "等待用户选择下一步",
            completed: false,
          },
        ],
      },
      {
        type: "text",
        content: "我先把两条改造路径收敛出来，方便你在飞书里直接选择。",
        planInteraction: {
          question: "你希望我下一步先做哪件事？",
          choices: [
            {
              choiceId: "architecture",
              label: "先梳理架构",
              description: "只输出改造边界与影响面，不改代码。",
              responseText: "先梳理架构与改造边界，不要直接改代码。",
            },
            {
              choiceId: "tests",
              label: "先补测试",
              description: "优先补齐验证路径和风险防线。",
              responseText: "先补测试和验证路径，不要直接改代码。",
            },
          ],
        },
      },
      {
        type: "done",
        content: "我先把两条改造路径收敛出来，方便你在飞书里直接选择。",
      },
    ]);
    expect(outcome.events).toEqual(seenEvents);
  });
});

function createChildFromFixture(fileName: string, exitCode: number) {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "codex",
    fileName,
  );
  const lines = readFileSync(fixturePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map(line => `${line}\n`);

  return Object.assign(
    Promise.resolve({
      exitCode,
    }),
    {
      stdout: Readable.from(lines),
    },
  );
}

function createChunkedChildFromFixture(
  fileName: string,
  exitCode: number,
  chunkSplits: number[],
) {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "codex",
    fileName,
  );
  const content = readFileSync(fixturePath, "utf8").trim();
  const lines = content.split(/\r?\n/).map(line => `${line}\n`);
  const chunks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (chunkSplits.includes(index)) {
      const splitPoint = Math.max(1, Math.floor(line.length / 2));
      chunks.push(line.slice(0, splitPoint));
      chunks.push(line.slice(splitPoint));
      continue;
    }

    chunks.push(line);
  }

  return Object.assign(
    Promise.resolve({
      exitCode,
    }),
    {
      stdout: Readable.from(chunks),
    },
  );
}
