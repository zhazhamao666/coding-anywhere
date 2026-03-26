import { describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/feishu-adapter.js";
import type { BridgeReply, ProgressCardState } from "../src/types.js";

describe("FeishuAdapter group thread routing", () => {
  it("routes thread messages with chat_id and thread_id to CA", async () => {
    const bridgeService = {
      handleMessage: vi.fn(
        async (
          _input: {
            channel: string;
            peerId?: string;
            chatId?: string;
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
        text: "/ca project bind-current proj-a coding-anywhere Demo Project",
      },
      {
        onProgress: expect.any(Function),
      },
    );
    expect(apiClient.replyTextMessage).toHaveBeenCalledWith("om_2", "[ca] ok");
  });
});

function createApiClientDouble() {
  return {
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
  };
}
