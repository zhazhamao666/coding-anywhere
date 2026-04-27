import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (isMainModule(import.meta.url)) {
  const surface = normalizeSurface(process.argv[2] ?? process.env.FEISHU_LIVE_SURFACE);
  const command = buildFeishuLivePlaywrightCommand(process.platform);
  const result = spawnSync(
    command.file,
    command.args,
    {
      stdio: "inherit",
      env: {
        ...process.env,
        FEISHU_LIVE_SURFACE: surface,
      },
    },
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

export function buildFeishuLivePlaywrightCommand(platform = process.platform) {
  if (platform === "win32") {
    return {
      file: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npm exec -- playwright test -c playwright.config.ts --project=feishu-live",
      ],
    };
  }

  return {
    file: "npm",
    args: [
      "exec",
      "--",
      "playwright",
      "test",
      "-c",
      "playwright.config.ts",
      "--project=feishu-live",
    ],
  };
}

export function normalizeSurface(rawSurface) {
  return rawSurface?.trim().toLowerCase() === "group" ? "group" : "dm";
}

function isMainModule(metaUrl) {
  return process.argv[1] && fileURLToPath(metaUrl) === process.argv[1];
}
