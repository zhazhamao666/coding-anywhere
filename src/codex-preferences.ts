import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { parse } from "toml";

import type { BridgeConfig } from "./config.js";
import type { CodexPreferenceCatalog, CodexReasoningEffort, CodexSpeed } from "./types.js";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "high";
const DEFAULT_SPEED: CodexSpeed = "standard";
const DEFAULT_REASONING_OPTIONS: CodexReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];
const DEFAULT_SPEED_OPTIONS: CodexSpeed[] = ["standard", "fast"];
const COMMON_MODEL_OPTIONS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
];
const MODEL_LABELS: Record<string, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4-Mini",
  "gpt-5.3-codex": "GPT-5.3-Codex",
  "gpt-5.3-codex-spark": "GPT-5.3-Codex-Spark",
  "gpt-5.2-codex": "GPT-5.2-Codex",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.1-codex-max": "GPT-5.1-Codex-Max",
  "gpt-5.1-codex-mini": "GPT-5.1-Codex-Mini",
};
const REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
};
const SPEED_LABELS: Record<CodexSpeed, string> = {
  standard: "标准",
  fast: "快速",
};

interface RawCodexConfig {
  model?: unknown;
  model_reasoning_effort?: unknown;
  service_tier?: unknown;
  profiles?: Record<string, {
    model?: unknown;
    model_reasoning_effort?: unknown;
    service_tier?: unknown;
  }>;
}

interface RawCodexGlobalState {
  "electron-persisted-atom-state"?: {
    "default-service-tier"?: unknown;
  };
}

export function resolveCodexPreferenceCatalog(
  codexConfig: BridgeConfig["codex"],
  options?: {
    codexHomePath?: string;
  },
): CodexPreferenceCatalog {
  const discovered = loadGlobalCodexPreferenceHints(options?.codexHomePath);
  const defaultModel =
    normalizeCodexModel(codexConfig.defaultModel) ??
    discovered.defaultModel ??
    DEFAULT_MODEL;
  const defaultReasoningEffort =
    normalizeReasoningEffort(codexConfig.defaultReasoningEffort) ??
    discovered.defaultReasoningEffort ??
    DEFAULT_REASONING_EFFORT;
  const defaultSpeed =
    normalizeCodexSpeed(codexConfig.defaultSpeed) ??
    discovered.defaultSpeed ??
    DEFAULT_SPEED;

  return {
    defaultModel,
    defaultReasoningEffort,
    defaultSpeed,
    modelOptions: orderCodexModels(uniqueStrings([
      defaultModel,
      ...(codexConfig.modelOptions ?? []),
      ...discovered.modelOptions,
      ...COMMON_MODEL_OPTIONS,
    ])),
    reasoningEffortOptions: orderReasoningEfforts(uniqueReasoningEfforts([
      defaultReasoningEffort,
      ...(codexConfig.reasoningEffortOptions ?? []),
      ...discovered.reasoningEffortOptions,
      ...DEFAULT_REASONING_OPTIONS,
    ])),
    speedOptions: orderCodexSpeeds(uniqueCodexSpeeds([
      defaultSpeed,
      ...(codexConfig.speedOptions ?? []),
      ...discovered.speedOptions,
      ...DEFAULT_SPEED_OPTIONS,
    ])),
  };
}

function loadGlobalCodexPreferenceHints(codexHomePath = resolveCodexHomePath()): {
  defaultModel?: string;
  defaultReasoningEffort?: CodexReasoningEffort;
  defaultSpeed?: CodexSpeed;
  modelOptions: string[];
  reasoningEffortOptions: CodexReasoningEffort[];
  speedOptions: CodexSpeed[];
} {
  const configPath = path.join(codexHomePath, "config.toml");
  const globalStatePath = path.join(codexHomePath, ".codex-global-state.json");

  let discoveredFromConfig: {
    defaultModel?: string;
    defaultReasoningEffort?: CodexReasoningEffort;
    defaultSpeed?: CodexSpeed;
    modelOptions: string[];
    reasoningEffortOptions: CodexReasoningEffort[];
    speedOptions: CodexSpeed[];
  } = {
    modelOptions: [],
    reasoningEffortOptions: [],
    speedOptions: [],
  };

  if (existsSync(configPath)) {
    try {
      const parsed = parse(readFileSync(configPath, "utf8")) as RawCodexConfig;
      const profiles = Object.values(parsed.profiles ?? {});
      discoveredFromConfig = {
        defaultModel: normalizeCodexModel(parsed.model),
        defaultReasoningEffort: normalizeReasoningEffort(parsed.model_reasoning_effort),
        defaultSpeed: normalizeCodexCliServiceTier(parsed.service_tier),
        modelOptions: profiles
          .map(profile => normalizeCodexModel(profile.model))
          .filter((value): value is string => Boolean(value)),
        reasoningEffortOptions: profiles
          .map(profile => normalizeReasoningEffort(profile.model_reasoning_effort))
          .filter((value): value is CodexReasoningEffort => Boolean(value)),
        speedOptions: profiles
          .map(profile => normalizeCodexCliServiceTier(profile.service_tier))
          .filter((value): value is CodexSpeed => Boolean(value)),
      };
    } catch {
      discoveredFromConfig = {
        modelOptions: [],
        reasoningEffortOptions: [],
        speedOptions: [],
      };
    }
  }

  if (!existsSync(globalStatePath)) {
    return discoveredFromConfig;
  }

  try {
    const parsed = JSON.parse(readFileSync(globalStatePath, "utf8")) as RawCodexGlobalState;
    return {
      ...discoveredFromConfig,
      defaultSpeed:
        discoveredFromConfig.defaultSpeed ??
        normalizeCodexCliServiceTier(parsed["electron-persisted-atom-state"]?.["default-service-tier"]),
    };
  } catch {
    return discoveredFromConfig;
  }
}

function resolveCodexHomePath(): string {
  return process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeCodexModel(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }

  return normalized.toLowerCase().startsWith("gpt-")
    ? normalized.toLowerCase()
    : normalized;
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

export function normalizeCodexSpeed(value: unknown): CodexSpeed | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  switch (normalized) {
    case "standard":
      return "standard";
    case "fast":
      return "fast";
    default:
      return undefined;
  }
}

export function getCodexModelLabel(model: string): string {
  const normalized = normalizeCodexModel(model) ?? model;
  return MODEL_LABELS[normalized] ?? formatCodexModelLabel(normalized);
}

export function getCodexReasoningLabel(reasoningEffort: CodexReasoningEffort): string {
  return REASONING_LABELS[reasoningEffort] ?? reasoningEffort;
}

export function getCodexSpeedLabel(speed: CodexSpeed): string {
  return SPEED_LABELS[speed] ?? speed;
}

export function getFallbackCodexPreferenceCatalog(): CodexPreferenceCatalog {
  return {
    defaultModel: DEFAULT_MODEL,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    defaultSpeed: DEFAULT_SPEED,
    modelOptions: orderCodexModels([...COMMON_MODEL_OPTIONS]),
    reasoningEffortOptions: [...DEFAULT_REASONING_OPTIONS],
    speedOptions: [...DEFAULT_SPEED_OPTIONS],
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = normalizeCodexModel(value);
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

function uniqueCodexSpeeds(values: Array<CodexSpeed | string>): CodexSpeed[] {
  const seen = new Set<CodexSpeed>();
  const normalized: CodexSpeed[] = [];
  for (const value of values) {
    const speed = normalizeCodexSpeed(value);
    if (!speed || seen.has(speed)) {
      continue;
    }
    seen.add(speed);
    normalized.push(speed);
  }
  return normalized;
}

function orderCodexModels(values: string[]): string[] {
  const preferred = new Map(COMMON_MODEL_OPTIONS.map((value, index) => [value, index]));
  return [...values].sort((left, right) => {
    const leftRank = getCodexModelSortRank(left);
    const rightRank = getCodexModelSortRank(right);
    if (leftRank.family !== rightRank.family) {
      return leftRank.family - rightRank.family;
    }

    for (let index = 0; index < Math.max(leftRank.version.length, rightRank.version.length); index += 1) {
      const leftPart = leftRank.version[index] ?? 0;
      const rightPart = rightRank.version[index] ?? 0;
      if (leftPart !== rightPart) {
        return rightPart - leftPart;
      }
    }

    if (leftRank.variant !== rightRank.variant) {
      return leftRank.variant - rightRank.variant;
    }

    const leftPreferred = preferred.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPreferred = preferred.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred - rightPreferred;
    }

    return left.localeCompare(right);
  });
}

function getCodexModelSortRank(model: string): {
  family: number;
  version: number[];
  variant: number;
} {
  const normalized = normalizeCodexModel(model) ?? model;
  const gptMatch = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(normalized);
  if (gptMatch) {
    return {
      family: 0,
      version: parseModelVersion(gptMatch[1]),
      variant: getGptVariantRank(gptMatch[2]),
    };
  }

  return {
    family: normalized.toLowerCase().startsWith("codex-") ? 1 : 2,
    version: [],
    variant: 0,
  };
}

function parseModelVersion(version: string | undefined): number[] {
  return (version ?? "")
    .split(".")
    .map(part => Number.parseInt(part, 10))
    .map(part => Number.isFinite(part) ? part : 0);
}

function getGptVariantRank(suffix: string | undefined): number {
  const normalized = suffix?.toLowerCase() ?? "";
  if (normalized === "codex-max") {
    return 0;
  }
  if (normalized === "codex") {
    return 1;
  }
  if (normalized === "" || normalized === "pro") {
    return 2;
  }
  if (normalized.includes("spark")) {
    return 3;
  }
  if (normalized.includes("mini") || normalized.includes("nano")) {
    return 4;
  }
  return 10;
}

function formatCodexModelLabel(model: string): string {
  const gptMatch = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(model);
  if (gptMatch) {
    const suffix = gptMatch[2]
      ? `-${formatModelSuffix(gptMatch[2])}`
      : "";
    return `GPT-${gptMatch[1]}${suffix}`;
  }

  const codexMatch = /^codex-(.+)$/i.exec(model);
  if (codexMatch) {
    return `Codex-${formatModelSuffix(codexMatch[1])}`;
  }

  return model;
}

function formatModelSuffix(suffix: string): string {
  return suffix
    .split("-")
    .map(formatModelSuffixToken)
    .join("-");
}

function formatModelSuffixToken(token: string): string {
  const lower = token.toLowerCase();
  const known: Record<string, string> = {
    chat: "Chat",
    codex: "Codex",
    latest: "Latest",
    max: "Max",
    mini: "Mini",
    minimax: "MiniMax",
    nano: "Nano",
    pro: "Pro",
    spark: "Spark",
  };

  if (known[lower]) {
    return known[lower];
  }
  if (/^[a-z]*\d/i.test(token)) {
    return token.toUpperCase();
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function orderReasoningEfforts(values: CodexReasoningEffort[]): CodexReasoningEffort[] {
  const preferred = new Map(DEFAULT_REASONING_OPTIONS.map((value, index) => [value, index]));
  return [...values].sort((left, right) => {
    const leftPreferred = preferred.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPreferred = preferred.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred - rightPreferred;
    }
    return left.localeCompare(right);
  });
}

function orderCodexSpeeds(values: CodexSpeed[]): CodexSpeed[] {
  const preferred = new Map(DEFAULT_SPEED_OPTIONS.map((value, index) => [value, index]));
  return [...values].sort((left, right) => (preferred.get(left) ?? 99) - (preferred.get(right) ?? 99));
}

function normalizeCodexCliServiceTier(value: unknown): CodexSpeed | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  switch (normalized) {
    case "fast":
      return "fast";
    case "standard":
    case "default":
    case "auto":
    case "flex":
      return "standard";
    default:
      return undefined;
  }
}
