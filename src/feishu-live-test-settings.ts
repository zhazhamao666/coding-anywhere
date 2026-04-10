import path from "node:path";

import { loadConfig, type BridgeConfig } from "./config.js";

export interface FeishuLiveTestSettings {
  cwd: string;
  dmUrl?: string;
  opsBaseUrl: string;
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
  const dmUrl = env.FEISHU_LIVE_DM_URL;
  const opsBaseUrl = env.FEISHU_LIVE_OPS_BASE_URL ?? deriveOpsBaseUrl(cwd, dependencies);

  return {
    cwd,
    dmUrl,
    opsBaseUrl,
  };
}

export function assertFeishuLiveDmConfigured(
  input?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
  dependencies?: {
    loadConfig?: (configPath: string) => Pick<BridgeConfig, "server">;
  },
): FeishuLiveTestSettings & { dmUrl: string } {
  const settings = loadFeishuLiveTestSettings(input, dependencies);
  if (!settings.dmUrl) {
    throw new Error(
      "[ca] Feishu live DM target is not configured. Set `FEISHU_LIVE_DM_URL` to the bot DM web URL before running the live smoke.",
    );
  }
  return {
    ...settings,
    dmUrl: settings.dmUrl,
  };
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
