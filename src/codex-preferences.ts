import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { parse } from "toml";

import type { BridgeConfig } from "./config.js";
import type { CodexPreferenceCatalog, CodexReasoningEffort } from "./types.js";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "high";
const DEFAULT_REASONING_OPTIONS: CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const COMMON_MODEL_OPTIONS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
];

interface RawCodexConfig {
  model?: unknown;
  model_reasoning_effort?: unknown;
  profiles?: Record<string, {
    model?: unknown;
    model_reasoning_effort?: unknown;
  }>;
}

export function resolveCodexPreferenceCatalog(
  codexConfig: BridgeConfig["codex"],
  options?: {
    codexHomePath?: string;
  },
): CodexPreferenceCatalog {
  const discovered = loadGlobalCodexPreferenceHints(options?.codexHomePath);
  const defaultModel =
    normalizeString(codexConfig.defaultModel) ??
    discovered.defaultModel ??
    DEFAULT_MODEL;
  const defaultReasoningEffort =
    normalizeReasoningEffort(codexConfig.defaultReasoningEffort) ??
    discovered.defaultReasoningEffort ??
    DEFAULT_REASONING_EFFORT;

  return {
    defaultModel,
    defaultReasoningEffort,
    modelOptions: uniqueStrings([
      defaultModel,
      ...(codexConfig.modelOptions ?? []),
      ...discovered.modelOptions,
      ...COMMON_MODEL_OPTIONS,
    ]),
    reasoningEffortOptions: uniqueReasoningEfforts([
      defaultReasoningEffort,
      ...(codexConfig.reasoningEffortOptions ?? []),
      ...discovered.reasoningEffortOptions,
      ...DEFAULT_REASONING_OPTIONS,
    ]),
  };
}

function loadGlobalCodexPreferenceHints(codexHomePath = resolveCodexHomePath()): {
  defaultModel?: string;
  defaultReasoningEffort?: CodexReasoningEffort;
  modelOptions: string[];
  reasoningEffortOptions: CodexReasoningEffort[];
} {
  const configPath = path.join(codexHomePath, "config.toml");
  if (!existsSync(configPath)) {
    return {
      modelOptions: [],
      reasoningEffortOptions: [],
    };
  }

  try {
    const parsed = parse(readFileSync(configPath, "utf8")) as RawCodexConfig;
    const profileModels = Object.values(parsed.profiles ?? {})
      .map(profile => normalizeString(profile.model))
      .filter((value): value is string => Boolean(value));
    const profileEfforts = Object.values(parsed.profiles ?? {})
      .map(profile => normalizeReasoningEffort(profile.model_reasoning_effort))
      .filter((value): value is CodexReasoningEffort => Boolean(value));

    return {
      defaultModel: normalizeString(parsed.model),
      defaultReasoningEffort: normalizeReasoningEffort(parsed.model_reasoning_effort),
      modelOptions: profileModels,
      reasoningEffortOptions: profileEfforts,
    };
  } catch {
    return {
      modelOptions: [],
      reasoningEffortOptions: [],
    };
  }
}

function resolveCodexHomePath(): string {
  return process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  switch (normalized) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    default:
      return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function uniqueReasoningEfforts(values: Array<CodexReasoningEffort | string>): CodexReasoningEffort[] {
  const seen = new Set<CodexReasoningEffort>();
  const normalized: CodexReasoningEffort[] = [];
  for (const value of values) {
    const effort = normalizeReasoningEffort(value);
    if (!effort || seen.has(effort)) {
      continue;
    }
    seen.add(effort);
    normalized.push(effort);
  }
  return normalized;
}
