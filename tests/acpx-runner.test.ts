import { Readable } from "node:stream";

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
    const lines = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread-native-1",
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "READY",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
      }),
    ];
    const child = Object.assign(
      Promise.resolve({
        exitCode: 0,
      }),
      {
        stdout: Readable.from([`${lines[0]}\n${lines[1]}\n${lines[2]}\n`]),
      },
    );
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
    expect(outcome.threadId).toBe("thread-native-1");
    expect(seenEvents).toEqual([
      { type: "text", content: "READY" },
      { type: "done", content: "READY" },
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
    const lines = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "你",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "好",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
      }),
    ];

    const child = Object.assign(
      Promise.resolve({
        exitCode: 0,
      }),
      {
        stdout: Readable.from([
          `${lines[0]}\n${lines[1].slice(0, 24)}`,
          `${lines[1].slice(24)}\n${lines[2]}\n`,
        ]),
      },
    );
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
      { type: "text", content: "你" },
      { type: "text", content: "你好" },
      { type: "done", content: "你好" },
    ]);
    expect(outcome.events).toEqual([
      { type: "text", content: "你" },
      { type: "text", content: "你好" },
      { type: "done", content: "你好" },
    ]);
  });
});
