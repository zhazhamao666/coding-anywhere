import { describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/feishu-adapter.js";

describe("group mention gating", () => {
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

  it("drops non-mentioned group messages when mention-only fallback is enabled", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
    };

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient: createApiClientDouble(),
      requireGroupMention: true,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-group-1",
      },
      event: {
        message: {
          message_id: "om_1",
          chat_id: "oc_chat_1",
          chat_type: "group",
          message_type: "text",
          thread_id: "omt_1",
          content: JSON.stringify({ text: "continue" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(bridgeService.handleMessage).not.toHaveBeenCalled();
  });

  it("drops mentioned group topic messages before mention-gated routing", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
    };

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient: createApiClientDouble(),
      requireGroupMention: true,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-group-mentioned-1",
      },
      event: {
        message: {
          message_id: "om_mentioned_1",
          chat_id: "oc_chat_1",
          chat_type: "group",
          message_type: "text",
          thread_id: "omt_1",
          content: JSON.stringify({ text: "@_user_1 continue" }),
          mentions: [
            {
              key: "@_user_1",
              mentioned_type: "bot",
            },
          ],
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(bridgeService.handleMessage).not.toHaveBeenCalled();
  });
});
