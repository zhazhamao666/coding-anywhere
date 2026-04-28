import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFeishuLiveTargetConfigured,
  loadFeishuLiveTestSettings,
} from "../src/feishu-live-test-settings.js";
import { buildFeishuLiveJourney } from "../src/feishu-live-journey.js";

const repoRoot = path.resolve(__dirname, "..");

describe("feishu live repository config", () => {
  it("ignores local auth artifacts in git", () => {
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");

    expect(gitignore).toContain(".auth/");
  });

  it("exposes auth bootstrap and explicit dm/group live smoke scripts", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.["test:feishu:auth"]).toBeTruthy();
    expect(pkg.scripts?.["test:feishu:live"]).toBeTruthy();
    expect(pkg.scripts?.["test:feishu:live:dm"]).toBeTruthy();
    expect(pkg.scripts?.["test:feishu:live:group"]).toBeTruthy();
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
  it("defaults to the autotest project and dm surface", () => {
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
    expect(settings.projectKey).toBe("coding-anywhere-autotest");
    expect(settings.surface).toBe("dm");
    expect(settings.allowNonAutotest).toBe(false);
  });

  it("uses explicit environment overrides for target, ops, surface, and project", () => {
    const settings = loadFeishuLiveTestSettings(
      {
        cwd: "D:\\repo\\coding-anywhere",
        env: {
          FEISHU_LIVE_TARGET_URL: "https://feishu.cn/messages/abc",
          FEISHU_LIVE_OPS_BASE_URL: "http://localhost:3000",
          FEISHU_LIVE_PROJECT_KEY: "coding-anywhere-autotest",
          FEISHU_LIVE_SURFACE: "group",
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

    expect(settings.targetUrl).toBe("https://feishu.cn/messages/abc");
    expect(settings.opsBaseUrl).toBe("http://localhost:3000");
    expect(settings.projectKey).toBe("coding-anywhere-autotest");
    expect(settings.surface).toBe("group");
    expect(settings.conversationName).toBe("coding-anywhere-autotest");
  });

  it("still accepts the legacy dm url variable as the target url", () => {
    const settings = loadFeishuLiveTestSettings(
      {
        cwd: "D:\\repo\\coding-anywhere",
        env: {
          FEISHU_LIVE_DM_URL: "https://feishu.cn/messages/legacy",
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

    expect(settings.targetUrl).toBe("https://feishu.cn/messages/legacy");
  });

  it("throws a clear error when the live target url is not configured", () => {
    expect(() =>
      assertFeishuLiveTargetConfigured(
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
      "[ca] Feishu live target URL is not configured. Set `FEISHU_LIVE_TARGET_URL` (or legacy `FEISHU_LIVE_DM_URL`) before running the live smoke.",
    );
  });

  it("rejects non-autotest project keys unless the danger override is explicit", () => {
    expect(() =>
      assertFeishuLiveTargetConfigured(
        {
          cwd: "D:\\repo\\coding-anywhere",
          env: {
            FEISHU_LIVE_TARGET_URL: "https://feishu.cn/messages/abc",
            FEISHU_LIVE_PROJECT_KEY: "coding-anywhere",
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
      ),
    ).toThrowError(
      "[ca] Feishu live smoke is locked to `coding-anywhere-autotest`. Set `FEISHU_LIVE_ALLOW_NON_AUTOTEST=1` only if you intentionally need a non-test project.",
    );
  });

  it("rejects non-autotest group fixtures unless the danger override is explicit", () => {
    expect(() =>
      assertFeishuLiveTargetConfigured(
        {
          cwd: "D:\\repo\\coding-anywhere",
          env: {
            FEISHU_LIVE_TARGET_URL: "https://feishu.cn/messages/group",
            FEISHU_LIVE_SURFACE: "group",
            FEISHU_LIVE_CONVERSATION_NAME: "coding-anywhere",
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
      ),
    ).toThrowError(
      "[ca] Feishu group live smoke is locked to the test group `coding-anywhere-autotest`. Set `FEISHU_LIVE_ALLOW_NON_AUTOTEST=1` only if you intentionally need a different group fixture.",
    );
  });

  it("allows an explicit non-autotest override only behind the danger switch", () => {
    const settings = assertFeishuLiveTargetConfigured(
      {
        cwd: "D:\\repo\\coding-anywhere",
        env: {
          FEISHU_LIVE_TARGET_URL: "https://feishu.cn/messages/abc",
          FEISHU_LIVE_PROJECT_KEY: "coding-anywhere",
          FEISHU_LIVE_ALLOW_NON_AUTOTEST: "1",
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

    expect(settings.projectKey).toBe("coding-anywhere");
    expect(settings.allowNonAutotest).toBe(true);
  });

  it("allows a non-default group fixture only behind the danger switch", () => {
    const settings = assertFeishuLiveTargetConfigured(
      {
        cwd: "D:\\repo\\coding-anywhere",
        env: {
          FEISHU_LIVE_TARGET_URL: "https://feishu.cn/messages/group",
          FEISHU_LIVE_SURFACE: "group",
          FEISHU_LIVE_CONVERSATION_NAME: "coding-anywhere",
          FEISHU_LIVE_ALLOW_NON_AUTOTEST: "1",
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

    expect(settings.surface).toBe("group");
    expect(settings.conversationName).toBe("coding-anywhere");
    expect(settings.allowNonAutotest).toBe(true);
  });
});

describe("feishu live user journeys", () => {
  it("covers the DM project entry, card navigation, status, and session journeys", () => {
    const journey = buildFeishuLiveJourney({
      surface: "dm",
      projectKey: "coding-anywhere-autotest",
    });

    expect(journey.name).toBe("dm");
    expect(journey.setupSteps).toMatchObject([
      {
        kind: "command",
        text: "/ca project switch coding-anywhere-autotest",
        expectText: ["当前项目已切换"],
      },
    ]);
    expect(journey.steps).toMatchObject([
      {
        kind: "command",
        text: "/ca",
        expectAnyText: ["当前项目已选择", "当前会话已就绪"],
      },
      {
        kind: "click",
        label: "查看项目",
        expectText: ["选择项目", "coding-anywhere-autotest", "进入项目"],
      },
      {
        kind: "click",
        label: "返回当前会话",
        expectAnyText: ["当前项目已选择", "当前会话已就绪"],
      },
      {
        kind: "click",
        label: "切换线程",
        expectText: ["选择线程"],
      },
      {
        kind: "command",
        text: "/ca status",
        expectText: ["运行状态"],
      },
      {
        kind: "command",
        text: "/ca session",
        expectAnyText: ["当前项目已选择", "当前会话已就绪"],
      },
    ]);
  });

  it("covers the group fixture self-check, project list, current project, and status journeys", () => {
    const journey = buildFeishuLiveJourney({
      surface: "group",
      projectKey: "coding-anywhere-autotest",
    });

    expect(journey.name).toBe("group");
    expect(journey.setupSteps).toMatchObject([
      {
        kind: "command",
        text: "/ca project current",
        expectText: ["当前项目", "coding-anywhere-autotest"],
      },
    ]);
    expect(journey.steps).toMatchObject([
      {
        kind: "command",
        text: "/ca",
        expectAnyText: ["当前群已绑定项目", "当前会话已就绪"],
      },
      {
        kind: "click",
        label: "查看项目",
        expectText: ["项目列表", "已绑定当前群"],
      },
      {
        kind: "click",
        label: "当前项目",
        expectText: ["当前项目", "coding-anywhere-autotest"],
      },
      {
        kind: "command",
        text: "/ca status",
        expectText: ["运行状态"],
      },
    ]);
  });
});
