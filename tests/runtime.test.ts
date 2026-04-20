import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime, runRuntimeMaintenance } from "../src/runtime.js";
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
      codex: {
        command: "codex",
        modelOptions: [],
        reasoningEffortOptions: [],
        speedOptions: [],
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
        reconnectCount: -1,
        reconnectIntervalSeconds: 120,
        reconnectNonceSeconds: 30,
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
      codex: {
        command: "codex",
        modelOptions: [],
        reasoningEffortOptions: [],
        speedOptions: [],
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
        reconnectCount: -1,
        reconnectIntervalSeconds: 120,
        reconnectNonceSeconds: 30,
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

  it("recovers lingering non-terminal runs when the runtime boots", async () => {
    const sqlitePath = path.join(rootDir, "runtime-recovery.db");
    const seedStore = (await import("../src/workspace/session-store.js")).SessionStore;
    const seeded = new seedStore(sqlitePath);
    seeded.createRun({
      runId: "run-stale",
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
      rootId: "main",
      status: "running",
      stage: "text",
      latestPreview: "still working",
      startedAt: "2026-04-15T09:00:00.000Z",
      updatedAt: "2026-04-15T09:10:00.000Z",
    });
    seeded.close();

    const config: BridgeConfig = {
      server: { port: 3000, host: "127.0.0.1" },
      storage: {
        sqlitePath,
        logDir: path.join(rootDir, "logs"),
      },
      codex: {
        command: "codex",
        modelOptions: [],
        reasoningEffortOptions: [],
        speedOptions: [],
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
        reconnectCount: -1,
        reconnectIntervalSeconds: 120,
        reconnectNonceSeconds: 30,
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

    try {
      expect((runtime.store as any).getRun("run-stale")).toMatchObject({
        runId: "run-stale",
        status: "error",
        stage: "error",
        latestPreview: "[ca] run interrupted because the service restarted",
        updatedAt: "2026-04-15T09:10:00.000Z",
        finishedAt: expect.any(String),
      });
      expect((runtime.store as any).getOverview()).toMatchObject({
        activeRuns: 0,
      });
    } finally {
      runtime.store.close();
    }
  });

  it("injects the api client into the card action service so async card commands can patch results", async () => {
    const config: BridgeConfig = {
      server: { port: 3000, host: "127.0.0.1" },
      storage: {
        sqlitePath: path.join(rootDir, "runtime-card-action.db"),
        logDir: path.join(rootDir, "logs"),
      },
      codex: {
        command: "codex",
        modelOptions: [],
        reasoningEffortOptions: [],
        speedOptions: [],
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
        reconnectCount: -1,
        reconnectIntervalSeconds: 120,
        reconnectNonceSeconds: 30,
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
      sendInteractiveCard: vi.fn(async () => "msg-card-1"),
      replyInteractiveCard: vi.fn(async () => "msg-reply-card-1"),
      updateInteractiveCard: vi.fn(async () => undefined),
      createCardEntity: vi.fn(async () => "card-1"),
      sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
      streamCardElement: vi.fn(async () => undefined),
      setCardStreamingMode: vi.fn(async () => undefined),
      updateCardKitCard: vi.fn(async () => undefined),
    } satisfies FeishuApiClientLike;

    let capturedCardActionService: unknown;
    const runtime = await createRuntime(config, {
      createApiClient: () => apiClient,
      createWsClient: (_config, _adapter, cardActionService) => {
        capturedCardActionService = cardActionService;
        return {
          start: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
        };
      },
    });

    try {
      expect((capturedCardActionService as any).dependencies.apiClient).toBe(apiClient);
    } finally {
      runtime.store.close();
    }
  });

  it("expires stale pending image assets during runtime maintenance", async () => {
    const config: BridgeConfig = {
      server: { port: 3000, host: "127.0.0.1" },
      storage: {
        sqlitePath: path.join(rootDir, "runtime-maintenance.db"),
        logDir: path.join(rootDir, "logs"),
      },
      codex: {
        command: "codex",
        modelOptions: [],
        reasoningEffortOptions: [],
        speedOptions: [],
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
        reconnectCount: -1,
        reconnectIntervalSeconds: 120,
        reconnectNonceSeconds: 30,
      },
      root: {
        id: "main",
        name: "Main Root",
        cwd: "D:/repos",
        repoRoot: "D:/repos",
        branchPolicy: "reuse",
        permissionMode: "workspace-write",
        envAllowlist: ["PATH"],
        idleTtlHours: 1,
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

    try {
      const staleCreatedAt = "2026-03-31T09:00:00.000Z";
      const freshCreatedAt = "2026-03-31T11:30:00.000Z";
      const staleAsset = runtime.store.savePendingBridgeAsset({
        channel: "feishu",
        peerId: "ou_demo",
        messageId: "om_image_stale",
        resourceKey: "img_stale",
        localPath: path.join(rootDir, "stale.png"),
        fileName: "stale.png",
        mimeType: "image/png",
        fileSize: 1234,
        createdAt: staleCreatedAt,
      });
      const freshAsset = runtime.store.savePendingBridgeAsset({
        channel: "feishu",
        peerId: "ou_demo",
        messageId: "om_image_fresh",
        resourceKey: "img_fresh",
        localPath: path.join(rootDir, "fresh.png"),
        fileName: "fresh.png",
        mimeType: "image/png",
        fileSize: 1234,
        createdAt: freshCreatedAt,
      });

      await runRuntimeMaintenance({
        store: runtime.store,
        runner: runtime.runner,
        ttlHours: 1,
        now: new Date("2026-03-31T12:00:00.000Z"),
      });

      expect(runtime.store.listPendingBridgeAssetsForSurface({
        channel: "feishu",
        peerId: "ou_demo",
      })).toEqual([
        expect.objectContaining({
          assetId: freshAsset.assetId,
          messageId: "om_image_fresh",
          status: "pending",
        }),
      ]);
      expect((runtime.store as any).getBridgeAsset(staleAsset.assetId)).toMatchObject({
        messageId: "om_image_stale",
        status: "expired",
      });
    } finally {
      runtime.store.close();
    }
  });
});
