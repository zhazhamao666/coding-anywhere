import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CodexRealSmokeResult {
  workspaceDir: string;
  rawLines: string[];
  threadId?: string;
  usage?: CodexTokenUsage;
  exitCode: number;
}

export interface CodexRealHarnessOptions {
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  codexCommand?: string;
  spawnCodex?: SpawnCodex;
  maxCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface CodexSmokeInvocation {
  prompt: string;
  seedWorkspace?: (workspaceDir: string) => void | Promise<void>;
  extraArgs?: string[];
}

export type SpawnedCodexProcess = Promise<{ exitCode?: number }> & {
  stdout?: AsyncIterable<unknown> | NodeJS.ReadableStream | null;
};

export type SpawnCodex = (input: {
  command: string;
  args: string[];
  cwd: string;
  input: string;
  env: NodeJS.ProcessEnv;
}) => SpawnedCodexProcess;

interface ResolvedBudgets {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export function shouldRunRealCodexSmoke(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEST_CODEX_REAL === "1";
}

export function createCodexRealHarness(options: CodexRealHarnessOptions = {}) {
  const env = {
    ...process.env,
    ...options.env,
  };
  const codexCommand = options.codexCommand ?? "codex";
  const spawnCodex = options.spawnCodex ?? defaultSpawnCodex;
  const budgets = resolveBudgets(options, env);
  let callCount = 0;

  return {
    getCallCount() {
      return callCount;
    },
    async runEphemeralSmoke(input: CodexSmokeInvocation): Promise<CodexRealSmokeResult> {
      if (!shouldRunRealCodexSmoke(env)) {
        throw new Error("TEST_CODEX_REAL_REQUIRED");
      }

      if (callCount >= budgets.maxCalls) {
        throw new Error(
          `TEST_CODEX_MAX_CALLS exceeded: ${callCount + 1} > ${budgets.maxCalls}`,
        );
      }

      callCount += 1;

      const workspaceDir = await mkdtemp(
        path.join(options.tempRoot ?? os.tmpdir(), "codex-real-"),
      );

      try {
        if (input.seedWorkspace) {
          await input.seedWorkspace(workspaceDir);
        }

        const child = spawnCodex({
          command: codexCommand,
          args: [
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            ...(input.extraArgs ?? []),
            "--cd",
            workspaceDir,
          ],
          cwd: workspaceDir,
          input: input.prompt,
          env,
        });

        const transcript = await collectCodexTranscript(child.stdout);
        const result = await child;
        const exitCode = result.exitCode ?? 0;

        if (exitCode !== 0) {
          throw new Error(`CODEX_SMOKE_EXIT_${exitCode}`);
        }

        const usage = transcript.usage;
        if (!usage) {
          throw new Error("CODEX_SMOKE_USAGE_MISSING");
        }

        enforceBudgets(budgets, usage);

        return {
          workspaceDir,
          rawLines: transcript.rawLines,
          threadId: transcript.threadId,
          usage,
          exitCode,
        };
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    },
  };
}

function defaultSpawnCodex(input: {
  command: string;
  args: string[];
  cwd: string;
  input: string;
  env: NodeJS.ProcessEnv;
}): SpawnedCodexProcess {
  return execa(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    input: input.input,
    reject: false,
  });
}

function resolveBudgets(
  options: CodexRealHarnessOptions,
  env: NodeJS.ProcessEnv,
): ResolvedBudgets {
  return {
    maxCalls: resolveInteger(
      options.maxCalls ?? env.TEST_CODEX_MAX_CALLS,
      1,
      "TEST_CODEX_MAX_CALLS",
    ),
    maxInputTokens: resolveInteger(
      options.maxInputTokens ?? env.TEST_CODEX_MAX_INPUT_TOKENS,
      45_000,
      "TEST_CODEX_MAX_INPUT_TOKENS",
    ),
    maxOutputTokens: resolveInteger(
      options.maxOutputTokens ?? env.TEST_CODEX_MAX_OUTPUT_TOKENS,
      800,
      "TEST_CODEX_MAX_OUTPUT_TOKENS",
    ),
  };
}

function resolveInteger(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    throw new Error(`${label} must be a positive integer`);
  }

  return fallback;
}

async function collectCodexTranscript(stdout: SpawnedCodexProcess["stdout"]) {
  const rawLines: string[] = [];
  let threadId: string | undefined;
  let usage: CodexTokenUsage | undefined;
  let buffer = "";

  if (!stdout) {
    return {
      rawLines,
      threadId,
      usage,
    };
  }

  for await (const chunk of stdout) {
    buffer += chunkToString(chunk);
    const split = flushBuffer(buffer, rawLines, parsed => {
      threadId = threadId ?? parseThreadId(parsed);
      usage = usage ?? parseUsage(parsed);
    });
    buffer = split.remainingBuffer;
  }

  const finalSplit = flushBuffer(buffer, rawLines, parsed => {
    threadId = threadId ?? parseThreadId(parsed);
    usage = usage ?? parseUsage(parsed);
  });

  buffer = finalSplit.remainingBuffer;
  if (buffer.trim().length > 0) {
    rawLines.push(buffer);
    const parsed = tryParseJson(buffer);
    if (parsed) {
      threadId = threadId ?? parseThreadId(parsed);
      usage = usage ?? parseUsage(parsed);
    }
  }

  return {
    rawLines,
    threadId,
    usage,
  };
}

function flushBuffer(
  buffer: string,
  rawLines: string[],
  onParsed: (value: unknown) => void,
) {
  let remainingBuffer = buffer;
  while (true) {
    const newlineIndex = remainingBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = remainingBuffer.slice(0, newlineIndex).trimEnd();
    remainingBuffer = remainingBuffer.slice(newlineIndex + 1);
    if (line.length === 0) {
      continue;
    }

    rawLines.push(line);
    const parsed = tryParseJson(line);
    if (parsed) {
      onParsed(parsed);
    }
  }

  return {
    remainingBuffer,
  };
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseThreadId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const candidate = (parsed as Record<string, unknown>).thread_id;
  return typeof candidate === "string" ? candidate : undefined;
}

function parseUsage(parsed: unknown): CodexTokenUsage | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "turn.completed") {
    return undefined;
  }

  const turn = record.turn;
  const rawUsage =
    record.usage ??
    (turn && typeof turn === "object" ? (turn as Record<string, unknown>).usage : undefined);
  if (!rawUsage || typeof rawUsage !== "object") {
    return undefined;
  }

  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = readPositiveNumber(
    usage.input_tokens ?? usage.inputTokens,
    "input_tokens",
  );
  const outputTokens = readPositiveNumber(
    usage.output_tokens ?? usage.outputTokens,
    "output_tokens",
  );
  const cachedInputTokens = readPositiveNumber(
    usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
    "cached_input_tokens",
  );

  if (inputTokens === undefined || outputTokens === undefined || cachedInputTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function readPositiveNumber(value: unknown, label: string): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  void label;
  return undefined;
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString("utf8");
  }

  return String(chunk);
}

function enforceBudgets(budgets: ResolvedBudgets, usage: CodexTokenUsage) {
  if (usage.inputTokens > budgets.maxInputTokens) {
    throw new Error(
      `TEST_CODEX_MAX_INPUT_TOKENS exceeded: ${usage.inputTokens} > ${budgets.maxInputTokens}`,
    );
  }

  if (usage.outputTokens > budgets.maxOutputTokens) {
    throw new Error(
      `TEST_CODEX_MAX_OUTPUT_TOKENS exceeded: ${usage.outputTokens} > ${budgets.maxOutputTokens}`,
    );
  }
}
