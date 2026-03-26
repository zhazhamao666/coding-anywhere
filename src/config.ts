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

const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(3000),
    host: z.string().default("127.0.0.1"),
  }),
  storage: z.object({
    sqlitePath: z.string(),
    logDir: z.string(),
  }),
  acpx: z.object({
    command: z.string().default("acpx"),
    agent: z.string().default("codex"),
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
  }),
  root: RootSchema,
});

export type BridgeConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath: string): BridgeConfig {
  const raw = readFileSync(configPath, "utf8");
  const parsed = parse(raw);
  return ConfigSchema.parse(parsed);
}
