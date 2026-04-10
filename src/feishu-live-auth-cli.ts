import { chromium } from "@playwright/test";

import { bootstrapFeishuLiveAuth } from "./feishu-live-auth.js";

async function main(): Promise<void> {
  const targetUrl = process.env.FEISHU_LIVE_AUTH_URL;
  const paths = await bootstrapFeishuLiveAuth(
    {
      targetUrl,
    },
    {
      launchPersistentContext: (userDataDir, options) =>
        chromium.launchPersistentContext(userDataDir, options),
    },
  );

  process.stdout.write(
    `[ca] Feishu live auth refreshed. Persistent profile: ${paths.profileDir}\n`,
  );
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[ca] Feishu live auth bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
