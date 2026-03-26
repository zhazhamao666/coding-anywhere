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

  it("uses --name when ensuring a named session", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
    });

    const runner = new AcpxRunner("acpx", "codex");

    await runner.ensureSession({
      sessionName: "codex-demo",
      cwd: "D:/repo",
    });

    expect(execaMock).toHaveBeenCalledWith(
      "acpx",
      ["codex", "sessions", "ensure", "--name", "codex-demo"],
      {
        cwd: "D:/repo",
        reject: false,
      },
    );
  });

  it("passes the session name positionally when closing a session", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
    });

    const runner = new AcpxRunner("acpx", "codex");

    await runner.close({
      sessionName: "codex-demo",
      cwd: "D:/repo",
    });

    expect(execaMock).toHaveBeenCalledWith(
      "acpx",
      ["codex", "sessions", "close", "codex-demo"],
      {
        cwd: "D:/repo",
        reject: false,
      },
    );
  });

  it("requests strict json output and preserves streamed text chunks", async () => {
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "你",
            },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "好",
            },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          stopReason: "end_turn",
        },
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
        sessionName: "codex-demo",
        cwd: "D:/repo",
      },
      "test",
      event => {
        seenEvents.push(event);
      },
    );

    expect(execaMock).toHaveBeenCalledWith(
      "acpx",
      [
        "--format",
        "json",
        "--json-strict",
        "codex",
        "prompt",
        "--session",
        "codex-demo",
        "--file",
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
