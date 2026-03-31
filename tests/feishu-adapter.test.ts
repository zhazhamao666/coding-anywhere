import { describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/feishu-adapter.js";
import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import type { BridgeReply, ProgressCardState } from "../src/types.js";

describe("FeishuAdapter", () => {
  it("ignores duplicate event ids and only forwards the first DM payload", async () => {
    const bridgeService = {
      handleMessage: vi.fn(
        async (
          _input: { channel: string; peerId: string; text: string },
          options?: {
            onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
          },
        ) => {
          await options?.onProgress?.(createSnapshot({
            status: "queued",
            stage: "received",
            preview: "[ca] received",
          }));
          return [{ kind: "assistant", text: "收到，开始处理" } satisfies BridgeReply];
        },
      ),
    };
    const apiClient = createApiClientDouble();
    const logger = {
      info: vi.fn(),
    };
    const controller = {
      push: vi.fn(async () => undefined),
      finalizeError: vi.fn(async () => undefined),
    };

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
      createStreamingCardController: () => controller,
      logger,
    });

    const envelope = {
      header: {
        event_id: "evt-1",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你好，codex" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    };

    await adapter.handleEnvelope(envelope);
    await adapter.handleEnvelope(envelope);

    expect(bridgeService.handleMessage).toHaveBeenCalledTimes(1);
    expect(bridgeService.handleMessage).toHaveBeenCalledWith(
      {
        channel: "feishu",
        peerId: "ou_demo",
        text: "你好，codex",
      },
      {
        onProgress: expect.any(Function),
      },
    );
    expect(controller.push).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "received",
      }),
    );
    expect(apiClient.sendTextMessage).toHaveBeenCalledWith("ou_demo", "收到，开始处理");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("feishu recv"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("chat_type=p2p"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("text=\"你好，codex\""),
    );
  });

  it("sends an explicit CA error when the codex pipeline fails before any progress starts", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => {
        throw new Error("SESSION_INIT_FAILED");
      }),
    };
    const apiClient = createApiClientDouble();
    const controller = {
      push: vi.fn(async () => undefined),
      finalizeError: vi.fn(async () => undefined),
    };

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
      createStreamingCardController: () => controller,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-2",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "test" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(apiClient.sendTextMessage).toHaveBeenCalledWith(
      "ou_demo",
      "[ca] error: SESSION_INIT_FAILED",
    );
    expect(controller.finalizeError).not.toHaveBeenCalled();
  });

  it("deduplicates retries by message_id when event_id is missing", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [{ kind: "assistant", text: "响应正常。" } satisfies BridgeReply]),
    };
    const apiClient = createApiClientDouble();

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
    });

    const envelope = {
      event: {
        message: {
          message_id: "om_retry_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "test" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    };

    await adapter.handleEnvelope(envelope);
    await adapter.handleEnvelope(envelope);

    expect(bridgeService.handleMessage).toHaveBeenCalledTimes(1);
    expect(apiClient.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("sends action cards as standard interactive messages", async () => {
    const hubCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "CA Hub",
        },
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: "**CA Hub**",
          },
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
                      content: "当前项目",
                    },
                    value: {
                      command: "/ca project current",
                      chatId: "oc_chat_current",
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
        { kind: "card", card: hubCard } as unknown as BridgeReply,
      ]),
    };
    const apiClient = createApiClientDouble();

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-card-1",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/ca hub" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(apiClient.sendInteractiveCard).toHaveBeenCalledWith("ou_demo", hubCard);
    expect(apiClient.createCardEntity).not.toHaveBeenCalled();
    expect(apiClient.updateCardKitCard).not.toHaveBeenCalled();
    expect(apiClient.sendCardKitMessage).not.toHaveBeenCalled();
    expect(apiClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it("delivers image replies from card actions as native image messages when possible", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        {
          kind: "image",
          localPath: "D:/tmp/result.png",
          caption: "结果图",
        } as unknown as BridgeReply,
      ]),
    };
    const apiClient = createApiClientDouble();
    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(card).toMatchObject({
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "命令已提交",
            },
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(apiClient.uploadImage).toHaveBeenCalledWith({
        imagePath: "D:/tmp/result.png",
      });
      expect(apiClient.replyImageMessage).toHaveBeenCalledWith("om_card_1", "img-uploaded-1");
      expect(apiClient.sendImageMessage).not.toHaveBeenCalled();
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith(
        "om_card_1",
        expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "图片结果",
            }),
          }),
        }),
      );
    });
  });

  it("finalizes the streaming card when a normal message fails after progress has started", async () => {
    const bridgeService = {
      handleMessage: vi.fn(
        async (
          _input: { channel: string; peerId: string; text: string },
          options?: {
            onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
          },
        ) => {
          await options?.onProgress?.(createSnapshot({
            status: "queued",
            stage: "received",
            preview: "[ca] received",
          }));
          throw new Error("RUN_STREAM_FAILED");
        },
      ),
    };
    const apiClient = createApiClientDouble();
    const controller = {
      push: vi.fn(async () => undefined),
      finalizeError: vi.fn(async () => undefined),
    };

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
      createStreamingCardController: () => controller,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-3",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "执行任务" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(controller.finalizeError).toHaveBeenCalledWith("[ca] error: RUN_STREAM_FAILED");
    expect(apiClient.sendTextMessage).toHaveBeenCalledWith("ou_demo", "[ca] error: RUN_STREAM_FAILED");
  });
});

function createSnapshot(overrides?: Partial<ProgressCardState>): ProgressCardState {
  return {
    runId: "run-1",
    rootName: "main",
    sessionName: "codex-main",
    status: "queued",
    stage: "received",
    preview: "[ca] queued",
    startedAt: 1_000,
    elapsedMs: 0,
    ...overrides,
  };
}

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
    uploadImage: vi.fn(async () => ({ imageKey: "img-uploaded-1" })),
    sendImageMessage: vi.fn(async () => "msg-image-1"),
    replyImageMessage: vi.fn(async () => "msg-reply-image-1"),
  };
}
