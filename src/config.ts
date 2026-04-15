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

const CodexSchema = z.object({
  command: z.string().default("codex"),
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
