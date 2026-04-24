import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/feishu-adapter.js";
import type {
  BridgeAssetRecord,
  BridgeReply,
  ProgressCardState,
} from "../src/types.js";

describe("FeishuAdapter group thread routing", () => {
  it("routes thread messages with chat_id and thread_id to CA", async () => {
    const bridgeService = {
      handleMessage: vi.fn(
        async (
          _input: {
            channel: string;
            peerId?: string;
            chatId?: string;
            chatType?: string;
            surfaceType?: string;
            surfaceRef?: string;
            text: string;
          },
          _options?: {
            onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
          },
        ) => [] satisfies BridgeReply[],
      ),
    };

    const adapter = new FeishuAdapter({
      allowlist: ["ou_user"],
      bridgeService,
      apiClient: createApiClientDouble(),
    });

    await adapter.handleEnvelope({
      header: { event_id: "evt-1" },
      event: {
        sender: { sender_id: { open_id: "ou_user" } },
        message: {
          message_id: "om_1",
          chat_id: "oc_chat_1",
          chat_type: "group",
          message_type: "text",
          thread_id: "omt_thread_1",
          content: JSON.stringify({ text: "@bot continue" }),
        },
      },
    } as any);

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(
      {
        channel: "feishu",
        peerId: "ou_user",
        chatId: "oc_chat_1",
        chatType: "group",
        surfaceType: "thread",
        surfaceRef: "omt_thread_1",
        text: "@bot continue",
      },
      {
        onProgress: expect.any(Function),
      },
    );
  });

  it("routes group mainline CA commands with the current chat_id", async () => {
    const bridgeService = {
      handleMessage: vi.fn(
        async () => [{ kind: "system", text: "[ca] ok" } satisfies BridgeReply],
      ),
    };

    const apiClient = createApiClientDouble();
    const adapter = new FeishuAdapter({
      allowlist: ["ou_user"],
      bridgeService,
      apiClient,
    });

    await adapter.handleEnvelope({
      header: { event_id: "evt-2" },
      event: {
        sender: { sender_id: { open_id: "ou_user" } },
        message: {
          message_id: "om_2",
          chat_id: "oc_chat_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "/ca project bind-current proj-a coding-anywhere Demo Project" }),
        },
      },
    } as any);

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(
      {
        channel: "feishu",
        peerId: "ou_user",
        chatId: "oc_chat_1",
        chatType: "group",
        text: "/ca project bind-current proj-a coding-anywhere Demo Project",
      },
      {
        onProgress: expect.any(Function),
      },
    );
    expect(apiClient.replyTextMessage).toHaveBeenCalledWith("om_2", "[ca] ok");
  });

  it("stages thread image messages on the exact thread surface and replies inline", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-thread-image-"));

    try {
      const bridgeService = {
        handleMessage: vi.fn(async () => [] satisfies BridgeReply[]),
      };
      const apiClient = createApiClientDouble({
        downloadMessageResource: vi.fn(async () => ({
          resourceKey: "img_thread_1",
          localPath: path.join(rootDir, "img_thread_1.png"),
          fileName: "img_thread_1.png",
          mimeType: "image/png",
          fileSize: 4096,
        })),
      });
      const pendingAssetStore = createPendingAssetStoreDouble();
      const adapter = new FeishuAdapter({
        allowlist: ["ou_user"],
        bridgeService,
        apiClient,
        pendingAssetStore,
        inboundAssetRootDir: rootDir,
      });

      await adapter.handleEnvelope({
        header: { event_id: "evt-image-thread-1" },
        event: {
          sender: { sender_id: { open_id: "ou_user" } },
          message: {
            message_id: "om_thread_image_1",
            chat_id: "oc_chat_1",
            chat_type: "group",
            message_type: "image",
            thread_id: "omt_thread_1",
            content: JSON.stringify({ image_key: "img_thread_1" }),
          },
        },
      } as any);

      expect(bridgeService.handleMessage).not.toHaveBeenCalled();
      expect(apiClient.downloadMessageResource).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "om_thread_image_1",
          fileKey: "img_thread_1",
          type: "image",
          downloadDir: expect.stringContaining(rootDir),
        }),
      );
      expect(pendingAssetStore.savePendingBridgeAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "feishu",
          peerId: "ou_user",
          chatId: "oc_chat_1",
          surfaceType: "thread",
          surfaceRef: "omt_thread_1",
          messageId: "om_thread_image_1",
          resourceKey: "img_thread_1",
        }),
      );
      expect(apiClient.replyTextMessage).toHaveBeenCalledWith(
        "om_thread_image_1",
        "[ca] 已收到图片，请继续发送文字说明。",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("replies with native image messages inside the current group thread", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "image", localPath: "D:/tmp/thread-result.png" } satisfies BridgeReply,
      ]),
    };

    const apiClient = createApiClientDouble();
    const adapter = new FeishuAdapter({
      allowlist: ["ou_user"],
      bridgeService,
      apiClient,
    });

    await adapter.handleEnvelope({
      header: { event_id: "evt-thread-image-reply-1" },
      event: {
        sender: { sender_id: { open_id: "ou_user" } },
        message: {
          message_id: "om_thread_text_1",
          chat_id: "oc_chat_1",
          chat_type: "group",
          message_type: "text",
          thread_id: "omt_thread_1",
          content: JSON.stringify({ text: "@bot 请返回结果图" }),
        },
      },
    } as any);

    expect(apiClient.uploadImage).toHaveBeenCalledWith({
      imagePath: "D:/tmp/thread-result.png",
    });
    expect(apiClient.replyImageMessage).toHaveBeenCalledWith("om_thread_text_1", "img-uploaded-1");
    expect(apiClient.sendImageMessage).not.toHaveBeenCalled();
  });
});

function createApiClientDouble(overrides?: Record<string, unknown>) {
  return {
    sendTextMessage: vi.fn(async () => "msg-1"),
    sendTextMessageToChat: vi.fn(async () => ({ messageId: "msg-chat-1", threadId: "omt-1" })),
    replyTextMessage: vi.fn(async () => "msg-reply-1"),
    updateTextMessage: vi.fn(async () => undefined),
    downloadMessageResource: vi.fn(async () => ({
      resourceKey: "img-default",
      localPath: "D:/tmp/img-default.png",
      fileName: "img-default.png",
      mimeType: "image/png",
      fileSize: 1024,
    })),
    uploadImage: vi.fn(async () => "img-uploaded-1"),
    sendImageMessage: vi.fn(async () => "msg-image-1"),
    replyImageMessage: vi.fn(async () => "msg-reply-image-1"),
    sendInteractiveCard: vi.fn(async () => "msg-card-1"),
    replyInteractiveCard: vi.fn(async () => "msg-reply-card-1"),
    updateInteractiveCard: vi.fn(async () => undefined),
    createCardEntity: vi.fn(async () => "card-1"),
    sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
    streamCardElement: vi.fn(async () => undefined),
    setCardStreamingMode: vi.fn(async () => undefined),
    updateCardKitCard: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createPendingAssetStoreDouble() {
  return {
    savePendingBridgeAsset: vi.fn((input: Record<string, unknown>) => ({
      assetId: "asset-1",
      runId: null,
      channel: "feishu",
      peerId: "ou_user",
      chatId: "oc_chat_1",
      surfaceType: "thread",
      surfaceRef: "omt_1",
      messageId: "om_thread_image_1",
      resourceType: "image",
      resourceKey: "img_thread_1",
      localPath: "D:/tmp/img_thread_1.png",
      fileName: "img_thread_1.png",
      mimeType: "image/png",
      fileSize: 4096,
      status: "pending",
      errorText: null,
      createdAt: "2026-03-31T00:00:00.000Z",
      updatedAt: "2026-03-31T00:00:00.000Z",
      consumedAt: null,
      failedAt: null,
      expiredAt: null,
      ...input,
    }) as BridgeAssetRecord),
  };
}
