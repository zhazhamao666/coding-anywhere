import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCodexIsolatedHome,
  createCodexRealHarness,
  shouldRunRealCodexResumeSmoke,
} from "./helpers/codex-real-harness.js";

describe("shouldRunRealCodexResumeSmoke", () => {
  it("returns false when TEST_CODEX_REAL is unset", () => {
    expect(shouldRunRealCodexResumeSmoke({})).toBe(false);
  });

  it("returns false when TEST_CODEX_RESUME is unset", () => {
    expect(shouldRunRealCodexResumeSmoke({ TEST_CODEX_REAL: "1" })).toBe(false);
  });

  it("returns true when both TEST_CODEX_REAL and TEST_CODEX_RESUME are 1", () => {
    expect(
      shouldRunRealCodexResumeSmoke({
        TEST_CODEX_REAL: "1",
        TEST_CODEX_RESUME: "1",
      }),
    ).toBe(true);
  });
});

describe("createCodexIsolatedHome", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "codex-real-resume-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("copies bootstrap codex files but excludes live session state", async () => {
    const sourceHome = path.join(rootDir, "source-home");
    const sourceCodexHome = path.join(sourceHome, ".codex");
    mkdirSync(sourceCodexHome, { recursive: true });
    mkdirSync(path.join(sourceCodexHome, "sessions"), { recursive: true });
    writeFileSync(path.join(sourceCodexHome, "auth.json"), "{\"ok\":true}\n", "utf8");
    writeFileSync(path.join(sourceCodexHome, "config.toml"), "model = \"gpt-5\"\n", "utf8");
    writeFileSync(path.join(sourceCodexHome, "AGENTS.md"), "bootstrap\n", "utf8");
    writeFileSync(path.join(sourceCodexHome, "session_index.jsonl"), "{}\n", "utf8");
    writeFileSync(path.join(sourceCodexHome, "state_5.sqlite"), "sqlite", "utf8");
    writeFileSync(path.join(sourceCodexHome, "sessions", "old.jsonl"), "{}\n", "utf8");

    const isolated = await createCodexIsolatedHome({
      tempRoot: rootDir,
      sourceCodexHome,
      env: {
        USERPROFILE: sourceHome,
        HOME: sourceHome,
      },
    });

    expect(isolated.env.HOME).toBe(isolated.homeDir);
    expect(isolated.env.USERPROFILE).toBe(isolated.homeDir);
    expect(readFileSync(path.join(isolated.codexDir, "auth.json"), "utf8")).toContain("\"ok\":true");
    expect(readFileSync(path.join(isolated.codexDir, "config.toml"), "utf8")).toContain("model");
    expect(existsSync(path.join(isolated.codexDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(isolated.codexDir, "session_index.jsonl"))).toBe(false);
    expect(existsSync(path.join(isolated.codexDir, "state_5.sqlite"))).toBe(false);
    expect(existsSync(path.join(isolated.codexDir, "sessions"))).toBe(false);

    const cleanupTarget = isolated.homeDir;
    await isolated.cleanup();
    expect(existsSync(cleanupTarget)).toBe(false);
  });
});

describe("CodexRealHarness persistent resume support", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "codex-real-resume-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("uses a shared isolated home for create then resume without --ephemeral", async () => {
    const sourceHome = path.join(rootDir, "source-home");
    const sourceCodexHome = path.join(sourceHome, ".codex");
    mkdirSync(sourceCodexHome, { recursive: true });
    writeFileSync(path.join(sourceCodexHome, "auth.json"), "{\"ok\":true}\n", "utf8");

    const spawnCodex = vi
      .fn()
      .mockImplementationOnce(({ outputLastMessagePath, args, env }) => {
        if (!outputLastMessagePath) {
          throw new Error("outputLastMessagePath missing");
        }

        expect(args).not.toContain("--ephemeral");
        expect(env.HOME).toContain("codex-home-");
        writeFileSync(outputLastMessagePath, JSON.stringify({ token: "TOKEN-RESUME-123" }), "utf8");

        return createFakeCodexChild(
          [
            JSON.stringify({
              type: "thread.started",
              thread_id: "thread_resume_demo",
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: 10,
                cached_input_tokens: 1,
                output_tokens: 5,
              },
            }),
          ],
          0,
        );
      })
      .mockImplementationOnce(({ outputLastMessagePath, args, env }) => {
        if (!outputLastMessagePath) {
          throw new Error("outputLastMessagePath missing");
        }

        expect(args).toEqual(
          expect.arrayContaining([
            "exec",
            "resume",
            "--json",
            "thread_resume_demo",
            "-",
          ]),
        );
        expect(args).not.toContain("--ephemeral");
        expect(env.USERPROFILE).toContain("codex-home-");
        writeFileSync(outputLastMessagePath, JSON.stringify({ token: "TOKEN-RESUME-123" }), "utf8");

        return createFakeCodexChild(
          [
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: 12,
                cached_input_tokens: 2,
                output_tokens: 6,
              },
            }),
          ],
          0,
        );
      });

    const isolated = await createCodexIsolatedHome({
      tempRoot: rootDir,
      sourceCodexHome,
    });
    const harness = createCodexRealHarness({
      env: {
        TEST_CODEX_REAL: "1",
      },
      spawnCodex,
      tempRoot: rootDir,
      maxCalls: 2,
    });

    try {
      const createResult = await harness.runPersistentSmoke({
        isolatedHome: isolated,
        prompt: "Read TOKEN.txt and return JSON with a token field.",
        outputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
            },
          },
          required: ["token"],
          additionalProperties: false,
        },
        seedWorkspace(workspaceDir) {
          writeFileSync(path.join(workspaceDir, "TOKEN.txt"), "TOKEN-RESUME-123", "utf8");
        },
      });

      const resumeResult = await harness.runPersistentSmoke({
        isolatedHome: isolated,
        resumeThreadId: createResult.threadId,
        prompt: "Return the remembered token as JSON.",
        outputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
            },
          },
          required: ["token"],
          additionalProperties: false,
        },
      });

      expect(createResult.threadId).toBe("thread_resume_demo");
      expect(JSON.parse(createResult.lastMessage ?? "{}")).toEqual({
        token: "TOKEN-RESUME-123",
      });
      expect(JSON.parse(resumeResult.lastMessage ?? "{}")).toEqual({
        token: "TOKEN-RESUME-123",
      });
      expect(harness.getCallCount()).toBe(2);
    } finally {
      await isolated.cleanup();
    }
  });
});

const liveResumeSmoke = shouldRunRealCodexResumeSmoke({
  TEST_CODEX_REAL: process.env.TEST_CODEX_REAL,
  TEST_CODEX_RESUME: process.env.TEST_CODEX_RESUME,
});
const maybeIt = liveResumeSmoke ? it : it.skip;
const liveResumeTimeoutMs = 120_000;
const liveResumeMaxInputTokens = 200_000;
const liveResumeMaxOutputTokens = 2_000;

maybeIt(
  "runs a real isolated Codex resume smoke only when TEST_CODEX_REAL=1 and TEST_CODEX_RESUME=1",
  async () => {
    const isolated = await createCodexIsolatedHome();
    const harness = createCodexRealHarness({
      env: process.env,
      maxCalls: 2,
      maxInputTokens: liveResumeMaxInputTokens,
      maxOutputTokens: liveResumeMaxOutputTokens,
    });

    try {
      const createResult = await harness.runPersistentSmoke({
        isolatedHome: isolated,
        prompt: "Read TOKEN.txt and remember its exact value. Return JSON with a token field.",
        outputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
            },
          },
          required: ["token"],
          additionalProperties: false,
        },
        seedWorkspace(workspaceDir) {
          const fixturePath = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "fixtures",
            "codex",
            "workspaces",
            "resume",
            "TOKEN.txt",
          );
          writeFileSync(
            path.join(workspaceDir, "TOKEN.txt"),
            readFileSync(fixturePath, "utf8"),
            "utf8",
          );
        },
      });

      const resumeResult = await harness.runPersistentSmoke({
        isolatedHome: isolated,
        resumeThreadId: createResult.threadId,
        prompt: "Return the remembered token as JSON with a token field.",
        outputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
            },
          },
          required: ["token"],
          additionalProperties: false,
        },
      });

      expect(createResult.threadId).toBeDefined();
      expect(JSON.parse(createResult.lastMessage ?? "{}")).toEqual({
        token: "TOKEN-RESUME-123",
      });
      expect(JSON.parse(resumeResult.lastMessage ?? "{}")).toEqual({
        token: "TOKEN-RESUME-123",
      });
      expect(harness.getCallCount()).toBe(2);
    } finally {
      await isolated.cleanup();
    }
  },
  liveResumeTimeoutMs,
);

function createFakeCodexChild(lines: string[], exitCode: number) {
  return Object.assign(Promise.resolve({ exitCode }), {
    stdout: Readable.from(lines.map(line => `${line}\n`)),
  });
}
