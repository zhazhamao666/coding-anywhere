import { describe, expect, it, vi } from "vitest";

import { FeishuApiClient } from "../src/feishu-api-client.js";

describe("FeishuApiClient", () => {
  it("logs one outbound line for a continuous CardKit push sequence", async () => {
    const sdk = createSdkDouble();
    const logger = {
      info: vi.fn(),
    };
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
      {
        logger,
        now: () => 1_000,
        pushLogWindowMs: 60_000,
      },
    );

    const messageId = await client.sendCardKitMessage("ou_demo", "card-1");
    await client.streamCardElement("card-1", "streaming_content", "处理中", 2);
    await client.setCardStreamingMode("card-1", false, 3);
    await client.updateCardKitCard("card-1", { schema: "2.0" }, 4);

    expect(messageId).toBe("msg-cardkit-1");
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("feishu send"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("message_id=msg-cardkit-1"),
    );
  });

  it("logs a standalone interactive card patch once", async () => {
    const sdk = createSdkDouble();
    const logger = {
      info: vi.fn(),
    };
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
      {
        logger,
        now: () => 1_000,
        pushLogWindowMs: 60_000,
      },
    );

    await client.updateInteractiveCard("om_existing_1", {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "Updated Card",
        },
      },
    });
    await client.updateInteractiveCard("om_existing_1", {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "Updated Card",
        },
      },
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("feishu send"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("message_id=om_existing_1"),
    );
  });

  it("sends interactive cards with the IM create API", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    const messageId = await client.sendInteractiveCard("ou_demo", {
      schema: "2.0",
      body: { elements: [] },
    });

    expect(messageId).toBe("msg-card-1");
    expect(sdk.im.message.create).toHaveBeenCalledWith({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: "ou_demo",
        msg_type: "interactive",
        content: JSON.stringify({
          schema: "2.0",
          body: { elements: [] },
        }),
      },
    });
  });

  it("creates a CardKit entity and streams element content", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    const cardId = await client.createCardEntity({
      schema: "2.0",
      body: { elements: [] },
    });
    await client.streamCardElement(cardId, "streaming_content", "处理中", 2);

    expect(cardId).toBe("card-1");
    expect(sdk.cardkit.v1.card.create).toHaveBeenCalled();
    expect(sdk.cardkit.v1.cardElement.content).toHaveBeenCalledWith({
      path: {
        card_id: "card-1",
        element_id: "streaming_content",
      },
      data: {
        content: "处理中",
        sequence: 2,
      },
    });
  });

  it("sends messages by card_id and finalizes CardKit cards", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    const messageId = await client.sendCardKitMessage("ou_demo", "card-1");
    await client.setCardStreamingMode("card-1", false, 3);
    await client.updateCardKitCard("card-1", { schema: "2.0" }, 4);

    expect(messageId).toBe("msg-cardkit-1");
    expect(sdk.im.message.create).toHaveBeenCalledWith({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: "ou_demo",
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "card-1",
          },
        }),
      },
    });
    expect(sdk.cardkit.v1.card.settings).toHaveBeenCalledWith({
      path: {
        card_id: "card-1",
      },
      data: {
        settings: JSON.stringify({
          streaming_mode: false,
        }),
        sequence: 3,
      },
    });
    expect(sdk.cardkit.v1.card.update).toHaveBeenCalledWith({
      path: {
        card_id: "card-1",
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify({
            schema: "2.0",
          }),
        },
        sequence: 4,
      },
    });
  });
});

function createSdkDouble() {
  return {
    im: {
      message: {
        create: vi.fn(async ({ data }: { data: { content: string } }) => {
          const content = JSON.parse(data.content);
          return {
            data: {
              message_id: content.type === "card" ? "msg-cardkit-1" : "msg-card-1",
            },
          };
        }),
        reply: vi.fn(async () => ({
          data: {
            message_id: "msg-reply-1",
            thread_id: "omt-1",
          },
        })),
        patch: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
    },
    cardkit: {
      v1: {
        card: {
          create: vi.fn(async () => ({
            code: 0,
            data: {
              card_id: "card-1",
            },
          })),
          settings: vi.fn(async () => ({
            code: 0,
          })),
          update: vi.fn(async () => ({
            code: 0,
          })),
        },
        cardElement: {
          content: vi.fn(async () => ({
            code: 0,
          })),
        },
      },
    },
  };
}
