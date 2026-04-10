import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFeishuLiveDmConfigured,
  loadFeishuLiveTestSettings,
} from "../src/feishu-live-test-settings.js";

const repoRoot = path.resolve(__dirname, "..");

describe("feishu live repository config", () => {
  it("ignores local auth artifacts in git", () => {
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");

    expect(gitignore).toContain(".auth/");
  });

  it("exposes auth bootstrap and live smoke scripts", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.["test:feishu:auth"]).toBeTruthy();
    expect(pkg.scripts?.["test:feishu:live"]).toBeTruthy();
  });

  it("ships a live auth cli entrypoint", () => {
    const cliSource = readFileSync(
      path.join(repoRoot, "src", "feishu-live-auth-cli.ts"),
      "utf8",
    );

    expect(cliSource).toContain("bootstrapFeishuLiveAuth");
  });

  it("defines a dedicated playwright project for feishu live smoke", async () => {
    const configSource = readFileSync(
      path.join(repoRoot, "playwright.config.ts"),
      "utf8",
    );

    expect(configSource).toContain("name: \"feishu-live\"");
  });
});

describe("feishu live test settings", () => {
  it("derives the ops base url from config.toml when no override is provided", () => {
    const settings = loadFeishuLiveTestSettings(
      {
        cwd: "D:\\repo\\coding-anywhere",
        env: {},
      },
      {
        loadConfig: () => ({
          server: {
            host: "127.0.0.1",
            port: 8787,
          },
        }),
      },
    );

    expect(settings.opsBaseUrl).toBe("http://127.0.0.1:8787");
  });

  it("uses explicit environment overrides for dm and ops targets", () => {
    const settings = loadFeishuLiveTestSettings(
      {
        cwd: "D:\\repo\\coding-anywhere",
        env: {
          FEISHU_LIVE_DM_URL: "https://feishu.cn/messages/abc",
          FEISHU_LIVE_OPS_BASE_URL: "http://localhost:3000",
        },
      },
      {
        loadConfig: () => ({
          server: {
            host: "127.0.0.1",
            port: 8787,
          },
        }),
      },
    );

    expect(settings.dmUrl).toBe("https://feishu.cn/messages/abc");
    expect(settings.opsBaseUrl).toBe("http://localhost:3000");
  });

  it("throws a clear error when the dm target is not configured", () => {
    expect(() =>
      assertFeishuLiveDmConfigured(
        {
          cwd: "D:\\repo\\coding-anywhere",
          env: {},
        },
        {
          loadConfig: () => ({
            server: {
              host: "127.0.0.1",
              port: 8787,
            },
          }),
        },
      ),
    ).toThrowError(
      "[ca] Feishu live DM target is not configured. Set `FEISHU_LIVE_DM_URL` to the bot DM web URL before running the live smoke.",
    );
  });
});
