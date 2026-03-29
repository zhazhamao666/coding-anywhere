import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

import { AcpxRunner, parseAcpxEventLine } from "../src/acpx-runner.js";

describe("parseAcpxEventLine", () => {
  it("parses tool call events from acpx json-rpc updates", () => {
    const event = parseAcpxEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            title: "npm test",
          },
        },
      }),
    );

    expect(event).toEqual({
      type: "tool_call",
      toolName: "npm test",
      content: "npm test",
    });
  });

  it("ignores non-event json-rpc messages", () => {
    const event = parseAcpxEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        result: {
          protocolVersion: 1,
        },
      }),
    );

    expect(event).toBeUndefined();
  });
});

describe("AcpxRunner", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("does not shell out when ensuring native execution context", async () => {
    const runner = new AcpxRunner("acpx", "codex");

    await runner.ensureSession({
      targetKind: "codex_thread",
      threadId: "thread-demo",
      sessionName: "thread-demo",
      cwd: "D:/repo",
    });

    expect(execaMock).not.toHaveBeenCalled();
  });

  it("creates a native thread through codex exec and returns the thread id", async () => {
    const child = createChildFromFixture("create-thread.jsonl", 0);
    execaMock.mockReturnValue(child);

    const runner = new AcpxRunner("acpx", "codex");
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

    expect(execaMock).toHaveBeenCalledWith(
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
      {
        type: "tool_call",
        toolName: "powershell.exe -Command \"Get-Content 'C:\\Users\\eijud\\.agents\\skills\\using-superpowers\\SKILL.md' -Encoding utf8\"",
        content: "powershell.exe -Command \"Get-Content 'C:\\Users\\eijud\\.agents\\skills\\using-superpowers\\SKILL.md' -Encoding utf8\"",
      },
      { type: "text", content: "OK" },
      { type: "done", content: "OK" },
    ]);
  });

  it("treats close as a no-op for native-only execution", async () => {
    const runner = new AcpxRunner("acpx", "codex");

    await runner.close({
      targetKind: "codex_thread",
      threadId: "thread-demo",
      sessionName: "thread-demo",
      cwd: "D:/repo",
    });

    expect(execaMock).not.toHaveBeenCalled();
  });

  it("resumes an existing native thread and preserves streamed text chunks", async () => {
    const child = createChildFromFixture("resume-thread.jsonl", 0);
    execaMock.mockReturnValue(child);

    const runner = new AcpxRunner("acpx", "codex");
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
      {
        type: "tool_call",
        toolName: "powershell.exe -Command \"git status --short\"",
        content: "powershell.exe -Command \"git status --short\"",
      },
      { type: "text", content: "RESUMED" },
      { type: "done", content: "RESUMED" },
    ]);
    expect(outcome.events).toEqual([
      {
        type: "tool_call",
        toolName: "powershell.exe -Command \"git status --short\"",
        content: "powershell.exe -Command \"git status --short\"",
      },
      { type: "text", content: "RESUMED" },
      { type: "done", content: "RESUMED" },
    ]);
  });

  it("reports a failed command execution as an error and still completes the turn", async () => {
    const child = createChildFromFixture("command-failure.jsonl", 1);
    execaMock.mockReturnValue(child);

    const runner = new AcpxRunner("acpx", "codex");
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
});

function createChildFromFixture(fileName: string, exitCode: number) {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "codex", fileName);
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
