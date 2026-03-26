import { describe, expect, it, vi } from "vitest";

import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import type { BridgeReply } from "../src/types.js";

describe("FeishuCardActionService", () => {
  it("routes button callback commands through bridge service and returns the official raw-card callback payload", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "Current Project",
        },
      },
      body: {
        elements: [
          {
            tag: "column_set",
            columns: [
              {
                tag: "column",
                elements: [
                  {
                    tag: "button",
                    text: {
                      tag: "plain_text",
                      content: "导航",
                    },
                    value: {
                      command: "/ca hub",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
    };
    const apiClient = {
      updateInteractiveCard: vi.fn(async () => undefined),
      updateCardKitCard: vi.fn(async () => undefined),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      tenant_key: "tenant-demo",
      open_message_id: "om_card_1",
      token: "token-demo",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
          chatId: "oc_chat_current",
          cardId: "card-1",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project current",
    });
    expect(apiClient.updateCardKitCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
    expect(card).toEqual(
      expect.objectContaining({
        card: {
          type: "raw",
          data: expect.objectContaining({
            header: expect.objectContaining({
              title: expect.objectContaining({
                content: "Current Project",
              }),
            }),
          }),
        },
      }),
    );
  });

  it("falls back to callback open_message_id when action.value.messageId is missing", async () => {
    const replyCard = {
      config: {
        update_multi: true,
      },
      header: {
        title: {
          tag: "plain_text",
          content: "Current Project",
        },
      },
      elements: [],
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
    };
    const apiClient = {
      updateInteractiveCard: vi.fn(async () => undefined),
      updateCardKitCard: vi.fn(async () => undefined),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
    });

    await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_callback_1",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("wraps system replies in an info card with a specific title", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "system", text: "[ca] current project: none" } as BridgeReply,
      ]),
    };
    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
        },
      },
    });

    expect(card).toMatchObject({
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "命令结果",
            },
          },
        },
      },
    });
    expect(JSON.stringify(card)).toContain("[ca] current project: none");
    expect(JSON.stringify(card)).toContain("\"command\":\"/ca\"");
  });
});
