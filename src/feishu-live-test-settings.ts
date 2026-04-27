import path from "node:path";

import { loadConfig, type BridgeConfig } from "./config.js";

export type FeishuLiveSurface = "dm" | "group";

export const DEFAULT_FEISHU_LIVE_PROJECT_KEY = "coding-anywhere-autotest";
export const DEFAULT_FEISHU_LIVE_GROUP_NAME = "coding-anywhere-autotest";

export interface FeishuLiveTestSettings {
  cwd: string;
  targetUrl?: string;
  opsBaseUrl: string;
  projectKey: string;
  surface: FeishuLiveSurface;
  conversationName?: string;
  allowNonAutotest: boolean;
}

export function loadFeishuLiveTestSettings(
  input?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
  dependencies?: {
    loadConfig?: (configPath: string) => Pick<BridgeConfig, "server">;
  },
): FeishuLiveTestSettings {
  const cwd = input?.cwd ?? process.cwd();
  const env = input?.env ?? process.env;
  const targetUrl = env.FEISHU_LIVE_TARGET_URL?.trim() || env.FEISHU_LIVE_DM_URL?.trim() || undefined;
  const opsBaseUrl = env.FEISHU_LIVE_OPS_BASE_URL ?? deriveOpsBaseUrl(cwd, dependencies);
  const projectKey = env.FEISHU_LIVE_PROJECT_KEY?.trim() || DEFAULT_FEISHU_LIVE_PROJECT_KEY;
  const surface = normalizeLiveSurface(env.FEISHU_LIVE_SURFACE);
  const allowNonAutotest = env.FEISHU_LIVE_ALLOW_NON_AUTOTEST?.trim() === "1";
  const conversationName = env.FEISHU_LIVE_CONVERSATION_NAME?.trim()
    || (surface === "group" ? DEFAULT_FEISHU_LIVE_GROUP_NAME : undefined);

  return {
    cwd,
    targetUrl,
    opsBaseUrl,
    projectKey,
    surface,
    conversationName,
    allowNonAutotest,
  };
}

export function assertFeishuLiveTargetConfigured(
  input?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
  dependencies?: {
    loadConfig?: (configPath: string) => Pick<BridgeConfig, "server">;
  },
): FeishuLiveTestSettings & { targetUrl: string } {
  const settings = loadFeishuLiveTestSettings(input, dependencies);
  if (!settings.targetUrl) {
    throw new Error(
      "[ca] Feishu live target URL is not configured. Set `FEISHU_LIVE_TARGET_URL` (or legacy `FEISHU_LIVE_DM_URL`) before running the live smoke.",
    );
  }
  if (!settings.allowNonAutotest && settings.projectKey !== DEFAULT_FEISHU_LIVE_PROJECT_KEY) {
    throw new Error(
      `[ca] Feishu live smoke is locked to \`${DEFAULT_FEISHU_LIVE_PROJECT_KEY}\`. Set \`FEISHU_LIVE_ALLOW_NON_AUTOTEST=1\` only if you intentionally need a non-test project.`,
    );
  }
  if (
    settings.surface === "group"
    && !settings.allowNonAutotest
    && settings.conversationName !== DEFAULT_FEISHU_LIVE_GROUP_NAME
  ) {
    throw new Error(
      `[ca] Feishu group live smoke is locked to the test group \`${DEFAULT_FEISHU_LIVE_GROUP_NAME}\`. Set \`FEISHU_LIVE_ALLOW_NON_AUTOTEST=1\` only if you intentionally need a different group fixture.`,
    );
  }

  return {
    ...settings,
    targetUrl: settings.targetUrl,
  };
}

function normalizeLiveSurface(rawSurface: string | undefined): FeishuLiveSurface {
  return rawSurface?.trim().toLowerCase() === "group" ? "group" : "dm";
}

function deriveOpsBaseUrl(
  cwd: string,
  dependencies?: {
    loadConfig?: (configPath: string) => Pick<BridgeConfig, "server">;
  },
): string {
  const configPath = path.join(cwd, "config.toml");
  const config = (dependencies?.loadConfig ?? loadConfig)(configPath);
  return `http://${config.server.host}:${config.server.port}`;
}
