import { spawnSync } from "node:child_process";

const surface = normalizeSurface(process.argv[2] ?? process.env.FEISHU_LIVE_SURFACE);
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  command,
  ["playwright", "test", "-c", "playwright.config.ts", "--project=feishu-live"],
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

function normalizeSurface(rawSurface) {
  return rawSurface?.trim().toLowerCase() === "group" ? "group" : "dm";
}
