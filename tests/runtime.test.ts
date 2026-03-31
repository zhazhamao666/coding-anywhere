import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime } from "../src/runtime.js";
import type { BridgeConfig } from "../src/config.js";
import type { FeishuApiClientLike } from "../src/feishu-adapter.js";

describe("createRuntime", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "runtime-store-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("seeds the configured bridge root into the session store", async () => {
    const config: BridgeConfig = {
      server: { port: 3000, host: "127.0.0.1" },
      storage: {
        sqlitePath: path.join(rootDir, "runtime-test.db"),
        logDir: path.join(rootDir, "logs"),
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

  it("injects the session store as the pending image asset store", async () => {
    const config: BridgeConfig = {
      server: { port: 3000, host: "127.0.0.1" },
      storage: {
        sqlitePath: path.join(rootDir, "runtime-image.db"),
        logDir: path.join(rootDir, "logs"),
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

    const apiClient = {
      sendTextMessage: vi.fn(async () => "msg-1"),
      sendTextMessageToChat: vi.fn(async () => ({ messageId: "msg-chat-1", threadId: "omt-1" })),
      replyTextMessage: vi.fn(async () => "msg-reply-1"),
      updateTextMessage: vi.fn(async () => undefined),
      downloadMessageResource: vi.fn(async () => ({
        resourceKey: "img_dm_1",
        localPath: path.join(rootDir, "img_dm_1.png"),
        fileName: "img_dm_1.png",
        mimeType: "image/png",
        fileSize: 2048,
      })),
      sendInteractiveCard: vi.fn(async () => "msg-card-1"),
      replyInteractiveCard: vi.fn(async () => "msg-reply-card-1"),
      updateInteractiveCard: vi.fn(async () => undefined),
      createCardEntity: vi.fn(async () => "card-1"),
      sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
      streamCardElement: vi.fn(async () => undefined),
      setCardStreamingMode: vi.fn(async () => undefined),
      updateCardKitCard: vi.fn(async () => undefined),
    } satisfies FeishuApiClientLike;

    const runtime = await createRuntime(config, {
      createApiClient: () => apiClient,
      createWsClient: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      }),
    });

    try {
      expect((runtime.adapter as any).dependencies.pendingAssetStore).toBe(runtime.store);

      await runtime.adapter.handleEnvelope({
        header: { event_id: "evt-image-runtime-1" },
        event: {
          sender: { sender_id: { open_id: "ou_demo" } },
          message: {
            message_id: "om_runtime_image_1",
            chat_type: "p2p",
            message_type: "image",
            content: JSON.stringify({ image_key: "img_dm_1" }),
          },
        },
      } as any);

      expect(apiClient.downloadMessageResource).toHaveBeenCalledTimes(1);
      expect(apiClient.sendTextMessage).toHaveBeenCalledWith(
        "ou_demo",
        "[ca] 已收到图片，请继续发送文字说明。",
      );
    } finally {
      runtime.store.close();
    }
  });
});
