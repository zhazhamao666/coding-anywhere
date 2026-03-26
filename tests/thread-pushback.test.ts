import { describe, expect, it, vi } from "vitest";

import { StreamingCardController } from "../src/feishu-card/streaming-card-controller.js";

describe("thread pushback", () => {
  it("replies inside the thread using the stored anchor message", async () => {
    const apiClient = {
      replyTextMessage: vi.fn(async () => "om_error"),
      sendTextMessageToChat: vi.fn(async () => ({ messageId: "msg-chat-1", threadId: "omt-1" })),
      sendInteractiveCard: vi.fn(async () => "om_card"),
      replyInteractiveCard: vi.fn(async () => "om_card"),
      updateInteractiveCard: vi.fn(async () => undefined),
      createCardEntity: vi.fn(async () => "card-1"),
      sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
      streamCardElement: vi.fn(async () => undefined),
      setCardStreamingMode: vi.fn(async () => undefined),
      updateCardKitCard: vi.fn(async () => undefined),
    } as any;

    const controller = new StreamingCardController({
      peerId: "ou_user",
      apiClient,
      anchorMessageId: "om_anchor",
    } as any);

    await controller.finalizeError("boom");

    expect(apiClient.replyTextMessage).toHaveBeenCalledWith("om_anchor", "boom");
  });
});
