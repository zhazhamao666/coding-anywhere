import { readFileSync } from "node:fs";

import { parse } from "toml";
import { z } from "zod";

const RootSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  repoRoot: z.string(),
  branchPolicy: z.string(),
  permissionMode: z.enum(["readonly", "workspace-write", "danger-full-access"]),
  envAllowlist: z.array(z.string()),
  idleTtlHours: z.number().int().positive(),
});

const CodexReasoningSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
const CodexSpeedSchema = z.enum(["standard", "fast"]);

const CodexSchema = z.object({
  command: z.string().default("codex"),
  defaultModel: z.string().optional(),
  defaultReasoningEffort: CodexReasoningSchema.optional(),
  defaultSpeed: CodexSpeedSchema.optional(),
  modelOptions: z.array(z.string()).default([]),
  reasoningEffortOptions: z.array(CodexReasoningSchema).default([]),
  speedOptions: z.array(CodexSpeedSchema).default([]),
});

const RawConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(3000),
    host: z.string().default("127.0.0.1"),
  }),
  storage: z.object({
    sqlitePath: z.string(),
    logDir: z.string(),
  }),
  codex: CodexSchema.optional(),
  acpx: z.object({
    command: z.string().default("acpx"),
    agent: z.string().default("codex"),
  }).optional(),
  scheduler: z.object({
    maxConcurrentRuns: z.number().int().positive().default(2),
  }).default({
    maxConcurrentRuns: 2,
  }),
  feishu: z.object({
    appId: z.string(),
    appSecret: z.string(),
    websocketUrl: z.string().url(),
    apiBaseUrl: z.string().url(),
    allowlist: z.array(z.string()),
    desktopOwnerOpenId: z.string().optional(),
    requireGroupMention: z.boolean().default(false),
    encryptKey: z.string().default(""),
    reconnectCount: z.number().int().default(-1),
    reconnectIntervalSeconds: z.number().int().positive().default(120),
    reconnectNonceSeconds: z.number().int().nonnegative().default(30),
  }),
  root: RootSchema,
});

const BridgeConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(3000),
    host: z.string().default("127.0.0.1"),
  }),
  storage: z.object({
    sqlitePath: z.string(),
    logDir: z.string(),
  }),
  codex: CodexSchema.default({
    command: "codex",
    defaultModel: undefined,
    defaultReasoningEffort: undefined,
    defaultSpeed: undefined,
    modelOptions: [],
    reasoningEffortOptions: [],
    speedOptions: [],
  }),
  scheduler: z.object({
    maxConcurrentRuns: z.number().int().positive().default(2),
  }).default({
    maxConcurrentRuns: 2,
  }),
  feishu: z.object({
    appId: z.string(),
    appSecret: z.string(),
    websocketUrl: z.string().url(),
    apiBaseUrl: z.string().url(),
    allowlist: z.array(z.string()),
    desktopOwnerOpenId: z.string().optional(),
    requireGroupMention: z.boolean().default(false),
    encryptKey: z.string().default(""),
    reconnectCount: z.number().int().default(-1),
    reconnectIntervalSeconds: z.number().int().positive().default(120),
    reconnectNonceSeconds: z.number().int().nonnegative().default(30),
  }),
  root: RootSchema,
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export interface LoadedBridgeConfig {
  config: BridgeConfig;
  usedLegacyAcpxSection: boolean;
}

export function loadConfig(configPath: string): BridgeConfig {
  return loadConfigWithMetadata(configPath).config;
}

export function loadConfigWithMetadata(configPath: string): LoadedBridgeConfig {
  const raw = readFileSync(configPath, "utf8");
  const parsed = RawConfigSchema.parse(parse(raw));
  const usedLegacyAcpxSection = !parsed.codex && Boolean(parsed.acpx);
  const codexCommand = parsed.codex?.command ?? normalizeLegacyCodexCommand(parsed.acpx?.command);
  const { acpx: _legacyAcpx, ...rest } = parsed;

  return {
    usedLegacyAcpxSection,
    config: BridgeConfigSchema.parse({
      ...rest,
      codex: {
        command: codexCommand,
        defaultModel: parsed.codex?.defaultModel,
        defaultReasoningEffort: parsed.codex?.defaultReasoningEffort,
        defaultSpeed: parsed.codex?.defaultSpeed,
        modelOptions: parsed.codex?.modelOptions ?? [],
        reasoningEffortOptions: parsed.codex?.reasoningEffortOptions ?? [],
        speedOptions: parsed.codex?.speedOptions ?? [],
      },
    }),
  };
}

function normalizeLegacyCodexCommand(command?: string): string {
  const normalized = command?.trim();
  if (!normalized || normalized.toLowerCase() === "acpx") {
    return "codex";
  }

  return normalized;
}
