import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createRuntime } from "../src/runtime.js";
import type { BridgeConfig } from "../src/config.js";
import type { FeishuApiClientLike } from "../src/feishu-adapter.js";

describe("createRuntime", () => {
  it("seeds the configured bridge root into the session store", async () => {
    const config: BridgeConfig = {
      server: { port: 3000, host: "127.0.0.1" },
      storage: {
        sqlitePath: path.join(process.cwd(), "data", "runtime-test.db"),
        logDir: path.join(process.cwd(), "logs"),
      },
      acpx: {
        command: "acpx",
        agent: "codex",
      },
      scheduler: {
        maxConcurrentRuns: 2,
      },
      feishu: {
        appId: "cli_xxx",
        appSecret: "secret",
        websocketUrl: "wss://example.invalid/ws",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
        allowlist: ["ou_demo"],
        requireGroupMention: false,
        encryptKey: "",
      },
      root: {
        id: "main",
        name: "Main Root",
        cwd: "D:/repos",
        repoRoot: "D:/repos",
        branchPolicy: "reuse",
        permissionMode: "workspace-write",
        envAllowlist: ["PATH"],
        idleTtlHours: 24,
      },
    };

    const runtime = await createRuntime(config, {
      createApiClient: (): FeishuApiClientLike => ({
        sendTextMessage: vi.fn(async () => "msg-1"),
        sendTextMessageToChat: vi.fn(async () => ({ messageId: "msg-chat-1", threadId: "omt-1" })),
        replyTextMessage: vi.fn(async () => "msg-reply-1"),
        updateTextMessage: vi.fn(async () => undefined),
        sendInteractiveCard: vi.fn(async () => "msg-card-1"),
        replyInteractiveCard: vi.fn(async () => "msg-reply-card-1"),
        updateInteractiveCard: vi.fn(async () => undefined),
        createCardEntity: vi.fn(async () => "card-1"),
        sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
        streamCardElement: vi.fn(async () => undefined),
        setCardStreamingMode: vi.fn(async () => undefined),
        updateCardKitCard: vi.fn(async () => undefined),
      }),
      createWsClient: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      }),
    });

    expect(runtime.store.getRoot()).toMatchObject({
      id: "main",
      cwd: "D:/repos",
    });
    expect((runtime.store as any).getOverview).toEqual(expect.any(Function));

    runtime.store.close();
  });
});
