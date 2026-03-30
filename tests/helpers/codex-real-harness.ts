import { mkdtemp, readFile, rm, writeFile, copyFile, mkdir } from "node:fs/promises";
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
  lastMessage?: string;
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

export interface CodexIsolatedHome {
  homeDir: string;
  codexDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export interface CodexIsolatedHomeOptions {
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  sourceCodexHome?: string;
}

export interface CodexSmokeInvocation {
  prompt: string;
  seedWorkspace?: (workspaceDir: string) => void | Promise<void>;
  extraArgs?: string[];
  outputSchema?: Record<string, unknown>;
}

export interface CodexPersistentSmokeInvocation extends CodexSmokeInvocation {
  isolatedHome: CodexIsolatedHome;
  resumeThreadId?: string;
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
  outputSchemaPath?: string;
  outputLastMessagePath?: string;
}) => SpawnedCodexProcess;

interface ResolvedBudgets {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export function shouldRunRealCodexSmoke(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEST_CODEX_REAL === "1";
}

export function shouldRunRealCodexResumeSmoke(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEST_CODEX_REAL === "1" && env.TEST_CODEX_RESUME === "1";
}

export async function createCodexIsolatedHome(
  options: CodexIsolatedHomeOptions = {},
): Promise<CodexIsolatedHome> {
  const env = {
    ...process.env,
    ...options.env,
  };
  const homeDir = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const sourceCodexHome = options.sourceCodexHome ?? resolveDefaultCodexHome(env);

  await mkdir(codexDir, { recursive: true });
  await copyBootstrapCodexFiles(sourceCodexHome, codexDir);

  return {
    homeDir,
    codexDir,
    env: {
      ...env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    async cleanup() {
      await rm(homeDir, { recursive: true, force: true });
    },
  };
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
      return runCodexSmoke({
        env,
        tempRoot: options.tempRoot,
        spawnCodex,
        codexCommand,
        budgets,
        callCountRef: () => callCount,
        incrementCallCount: () => {
          callCount += 1;
        },
        input,
        ephemeral: true,
      });
    },
    async runPersistentSmoke(
      input: CodexPersistentSmokeInvocation,
    ): Promise<CodexRealSmokeResult> {
      return runCodexSmoke({
        env: {
          ...env,
          ...input.isolatedHome.env,
        },
        tempRoot: options.tempRoot,
        spawnCodex,
        codexCommand,
        budgets,
        callCountRef: () => callCount,
        incrementCallCount: () => {
          callCount += 1;
        },
        input,
        ephemeral: false,
        resumeThreadId: input.resumeThreadId,
      });
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
      65_000,
      "TEST_CODEX_MAX_INPUT_TOKENS",
    ),
    maxOutputTokens: resolveInteger(
      options.maxOutputTokens ?? env.TEST_CODEX_MAX_OUTPUT_TOKENS,
      1_000,
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

async function runCodexSmoke(input: {
  env: NodeJS.ProcessEnv;
  tempRoot?: string;
  spawnCodex: SpawnCodex;
  codexCommand: string;
  budgets: ResolvedBudgets;
  callCountRef: () => number;
  incrementCallCount: () => void;
  input: CodexSmokeInvocation | CodexPersistentSmokeInvocation;
  ephemeral: boolean;
  cwd?: string;
  resumeThreadId?: string;
}): Promise<CodexRealSmokeResult> {
  if (!shouldRunRealCodexSmoke(input.env)) {
    throw new Error("TEST_CODEX_REAL_REQUIRED");
  }

  if (input.callCountRef() >= input.budgets.maxCalls) {
    throw new Error(
      `TEST_CODEX_MAX_CALLS exceeded: ${input.callCountRef() + 1} > ${input.budgets.maxCalls}`,
    );
  }

  const workspaceDir = await mkdtemp(
    path.join(input.tempRoot ?? os.tmpdir(), "codex-real-"),
  );
  const outputSchemaPath = input.input.outputSchema
    ? path.join(workspaceDir, "codex-output-schema.json")
    : undefined;
  const outputLastMessagePath = input.input.outputSchema
    ? path.join(workspaceDir, "codex-last-message.txt")
    : undefined;

  try {
    if (input.input.seedWorkspace) {
      await input.input.seedWorkspace(workspaceDir);
    }

    if (outputSchemaPath && input.input.outputSchema) {
      await writeFile(
        outputSchemaPath,
        `${JSON.stringify(input.input.outputSchema, null, 2)}\n`,
        "utf8",
      );
    }

    const child = input.spawnCodex({
      command: input.codexCommand,
      args: buildSmokeArgs({
        outputSchemaPath,
        outputLastMessagePath,
        extraArgs: input.input.extraArgs ?? [],
        ephemeral: input.ephemeral,
        workspaceDir,
        resumeThreadId: input.resumeThreadId,
      }),
      cwd: input.cwd ?? workspaceDir,
      env: input.env,
      input: input.input.prompt,
      outputSchemaPath,
      outputLastMessagePath,
    });
    input.incrementCallCount();

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

    let lastMessage: string | undefined;
    if (outputLastMessagePath) {
      const rawLastMessage = await readFile(outputLastMessagePath, "utf8");
      lastMessage = rawLastMessage.trimEnd();
      if (!lastMessage) {
        throw new Error("CODEX_SMOKE_LAST_MESSAGE_MISSING");
      }
    }

    enforceBudgets(input.budgets, usage);

    return {
      workspaceDir,
      rawLines: transcript.rawLines,
      threadId: transcript.threadId,
      usage,
      lastMessage,
      exitCode,
    };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

function buildSmokeArgs(input: {
  outputSchemaPath?: string;
  outputLastMessagePath?: string;
  extraArgs: string[];
  ephemeral: boolean;
  workspaceDir: string;
  resumeThreadId?: string;
}): string[] {
  return input.resumeThreadId
    ? [
        "exec",
        "resume",
        "--json",
        ...(input.ephemeral ? ["--ephemeral"] : []),
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        ...(input.outputSchemaPath ? ["--output-schema", input.outputSchemaPath] : []),
        ...(input.outputLastMessagePath
          ? ["--output-last-message", input.outputLastMessagePath]
          : []),
        ...input.extraArgs,
        input.resumeThreadId,
        "-",
      ]
    : [
        "exec",
        "--json",
        ...(input.ephemeral ? ["--ephemeral"] : []),
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        ...(input.outputSchemaPath ? ["--output-schema", input.outputSchemaPath] : []),
        ...(input.outputLastMessagePath
          ? ["--output-last-message", input.outputLastMessagePath]
          : []),
        ...input.extraArgs,
        "--cd",
        input.workspaceDir,
      ];
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
      const nextUsage = parseUsage(parsed);
      if (nextUsage) {
        usage = nextUsage;
      }
    });
    buffer = split.remainingBuffer;
  }

  const finalSplit = flushBuffer(buffer, rawLines, parsed => {
    threadId = threadId ?? parseThreadId(parsed);
    const nextUsage = parseUsage(parsed);
    if (nextUsage) {
      usage = nextUsage;
    }
  });

  buffer = finalSplit.remainingBuffer;
  if (buffer.trim().length > 0) {
    rawLines.push(buffer);
    const parsed = tryParseJson(buffer);
    if (parsed) {
      threadId = threadId ?? parseThreadId(parsed);
      const nextUsage = parseUsage(parsed);
      if (nextUsage) {
        usage = nextUsage;
      }
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

async function copyBootstrapCodexFiles(sourceCodexHome: string, targetCodexHome: string) {
  const bootstrapFiles = ["auth.json", "config.toml", "AGENTS.md", "version.json"];

  for (const fileName of bootstrapFiles) {
    const sourcePath = path.join(sourceCodexHome, fileName);
    const targetPath = path.join(targetCodexHome, fileName);
    try {
      await copyFile(sourcePath, targetPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
}

function resolveDefaultCodexHome(env: NodeJS.ProcessEnv): string {
  const profileRoot = env.USERPROFILE ?? env.HOME ?? os.homedir();
  return path.join(profileRoot, ".codex");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
