import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCodexRealHarness,
  shouldRunRealCodexSmoke,
} from "./helpers/codex-real-harness.js";

describe("shouldRunRealCodexSmoke", () => {
  it("returns false when TEST_CODEX_REAL is unset", () => {
    expect(shouldRunRealCodexSmoke({})).toBe(false);
  });

  it("returns true when TEST_CODEX_REAL is 1", () => {
    expect(shouldRunRealCodexSmoke({ TEST_CODEX_REAL: "1" })).toBe(true);
  });
});

describe("CodexRealHarness", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "codex-real-harness-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("collects raw JSONL lines, usage, and cleans the workspace after a successful run", async () => {
    const spawnCodex = vi.fn().mockReturnValue(
      createFakeCodexChild(
        [
          JSON.stringify({
            type: "thread.started",
            thread_id: "thread_123",
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 12,
              cached_input_tokens: 3,
              output_tokens: 4,
            },
          }),
        ],
        0,
      ),
    );

    const harness = createCodexRealHarness({
      env: {
        TEST_CODEX_REAL: "1",
        TEST_CODEX_MAX_CALLS: "2",
        TEST_CODEX_MAX_INPUT_TOKENS: "20",
        TEST_CODEX_MAX_OUTPUT_TOKENS: "10",
      },
      spawnCodex,
      tempRoot: rootDir,
    });

    const result = await harness.runEphemeralSmoke({
      prompt: "Read TOKEN.txt and report the token value.",
      seedWorkspace(workspaceDir) {
        writeFileSync(path.join(workspaceDir, "TOKEN.txt"), "TOKEN-123", "utf8");
      },
    });

    expect(spawnCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex",
        args: [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--cd",
          expect.stringContaining("codex-real-harness-"),
        ],
      }),
    );
    expect(result.threadId).toBe("thread_123");
    expect(result.usage).toEqual({
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 4,
    });
    expect(harness.getCallCount()).toBe(1);
    expect(result.rawLines).toEqual([
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread_123",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 12,
          cached_input_tokens: 3,
          output_tokens: 4,
        },
      }),
    ]);
    expect(existsSync(result.workspaceDir)).toBe(false);
  });

  it("rejects once the configured call budget is exhausted", async () => {
    const spawnCodex = vi.fn().mockReturnValue(
      createFakeCodexChild(
        [
          JSON.stringify({
            type: "thread.started",
            thread_id: "thread_123",
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 2,
              output_tokens: 1,
            },
          }),
        ],
        0,
      ),
    );

    const harness = createCodexRealHarness({
      env: {
        TEST_CODEX_REAL: "1",
        TEST_CODEX_MAX_CALLS: "1",
        TEST_CODEX_MAX_INPUT_TOKENS: "20",
        TEST_CODEX_MAX_OUTPUT_TOKENS: "10",
      },
      spawnCodex,
      tempRoot: rootDir,
    });

    await harness.runEphemeralSmoke({
      prompt: "First call",
    });
    expect(harness.getCallCount()).toBe(1);

    await expect(
      harness.runEphemeralSmoke({
        prompt: "Second call",
      }),
    ).rejects.toThrow(/TEST_CODEX_MAX_CALLS/i);
    expect(harness.getCallCount()).toBe(1);
    expect(spawnCodex).toHaveBeenCalledTimes(1);
    expect(readdirSync(rootDir)).toEqual([]);
  });

  it("does not consume call budget when workspace setup fails before spawn", async () => {
    const spawnCodex = vi.fn();
    const harness = createCodexRealHarness({
      env: {
        TEST_CODEX_REAL: "1",
        TEST_CODEX_MAX_CALLS: "1",
      },
      spawnCodex,
      tempRoot: rootDir,
    });

    rmSync(rootDir, { recursive: true, force: true });

    await expect(
      harness.runEphemeralSmoke({
        prompt: "Setup should fail",
      }),
    ).rejects.toThrow();
    expect(harness.getCallCount()).toBe(0);
    expect(spawnCodex).not.toHaveBeenCalled();
  });

  it("rejects when token usage exceeds the configured budget", async () => {
    const spawnCodex = vi.fn().mockReturnValue(
      createFakeCodexChild(
        [
          JSON.stringify({
            type: "thread.started",
            thread_id: "thread_123",
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 7,
              cached_input_tokens: 1,
              output_tokens: 5,
            },
          }),
        ],
        0,
      ),
    );

    const harness = createCodexRealHarness({
      env: {
        TEST_CODEX_REAL: "1",
        TEST_CODEX_MAX_CALLS: "2",
        TEST_CODEX_MAX_INPUT_TOKENS: "6",
        TEST_CODEX_MAX_OUTPUT_TOKENS: "4",
      },
      spawnCodex,
      tempRoot: rootDir,
    });

    await expect(
      harness.runEphemeralSmoke({
        prompt: "Budgeted call",
      }),
    ).rejects.toThrow(/TEST_CODEX_MAX_(INPUT|OUTPUT)_TOKENS/i);
    expect(harness.getCallCount()).toBe(1);
    expect(readdirSync(rootDir)).toEqual([]);
  });

  it("cleans up the workspace when Codex exits non-zero", async () => {
    const spawnCodex = vi.fn().mockReturnValue(
      createFakeCodexChild(
        [
          JSON.stringify({
            type: "thread.started",
            thread_id: "thread_123",
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 3,
              cached_input_tokens: 0,
              output_tokens: 2,
            },
          }),
        ],
        1,
      ),
    );

    const harness = createCodexRealHarness({
      env: {
        TEST_CODEX_REAL: "1",
        TEST_CODEX_MAX_CALLS: "2",
        TEST_CODEX_MAX_INPUT_TOKENS: "20",
        TEST_CODEX_MAX_OUTPUT_TOKENS: "10",
      },
      spawnCodex,
      tempRoot: rootDir,
    });

    await expect(
      harness.runEphemeralSmoke({
        prompt: "Fail this call",
      }),
    ).rejects.toThrow(/CODEX_SMOKE_EXIT_1/);
    expect(harness.getCallCount()).toBe(1);
    expect(readdirSync(rootDir)).toEqual([]);
  });
});

const liveSmoke = shouldRunRealCodexSmoke({
  TEST_CODEX_REAL: process.env.TEST_CODEX_REAL,
});

const maybeIt = liveSmoke ? it : it.skip;

maybeIt("runs a real Codex smoke only when TEST_CODEX_REAL=1", async () => {
  const harness = createCodexRealHarness({
    env: process.env,
  });

  const result = await harness.runEphemeralSmoke({
    prompt: "Reply with exactly OK.",
    seedWorkspace(workspaceDir) {
      writeFileSync(path.join(workspaceDir, "TOKEN.txt"), "TOKEN-123", "utf8");
    },
  });

  expect(result.threadId).toBeDefined();
  expect(result.rawLines.length).toBeGreaterThan(0);
});

function createFakeCodexChild(lines: string[], exitCode: number) {
  return Object.assign(Promise.resolve({ exitCode }), {
    stdout: Readable.from(lines.map(line => `${line}\n`)),
  });
}
