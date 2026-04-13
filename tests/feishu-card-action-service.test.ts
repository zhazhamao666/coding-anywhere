import { describe, expect, it, vi } from "vitest";

import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import type { BridgeReply } from "../src/types.js";

describe("FeishuCardActionService", () => {
  it("acks command button callbacks immediately and patches the final card reply asynchronously", async () => {
    const deferred = createDeferred<BridgeReply[]>();
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
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
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

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith("om_card_1", replyCard);
    });
  });

  it("falls back to callback open_message_id when patching an async command result", async () => {
    const deferred = createDeferred<BridgeReply[]>();
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
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const card = await service.handleAction({
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

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith("om_callback_1", replyCard);
    });
  });

  it("wraps system replies in an async result card with a specific title", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();
    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const card = await service.handleAction({
      open_message_id: "om_system_1",
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
              content: "命令已提交",
            },
          },
        },
      },
    });

    deferred.resolve([
      { kind: "system", text: "[ca] current project: none" } as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith(
        "om_system_1",
        expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "命令结果",
            }),
          }),
        }),
      );
    });

    const patchedCall = apiClient.updateInteractiveCard.mock.calls.at(-1) as [string, Record<string, unknown>] | undefined;
    const patchedCard = patchedCall?.[1];
    expect(JSON.stringify(patchedCard)).toContain("[ca] current project: none");
    expect(JSON.stringify(patchedCard)).toContain("\"command\":\"/ca\"");
  });

  it("returns a raw JSON 2.0 plan form card when the plan-mode button is clicked", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      handlePlanChoice: vi.fn(async () => []),
      getPendingPlanInteraction: vi.fn(() => undefined),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: createApiClientDouble() as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "open_plan_form",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.handleMessage).not.toHaveBeenCalled();
    expect(card).toMatchObject({
      card: {
        type: "raw",
        data: {
          schema: "2.0",
          header: {
            title: {
              content: "计划模式",
            },
          },
        },
      },
    });
    expect(JSON.stringify(card)).toContain("\"bridgeAction\":\"submit_plan_form\"");
  });

  it("submits a plan form asynchronously and returns an immediate ack card", async () => {
    const bridgeService = {
      handleMessage: vi.fn(() => new Promise<BridgeReply[]>(() => undefined)),
      handlePlanChoice: vi.fn(async () => []),
      getPendingPlanInteraction: vi.fn(() => undefined),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_plan_card_1",
      action: {
        tag: "button",
        form_value: {
          plan_prompt: "帮我先梳理这个仓库的改造方案，不要直接改代码",
        },
        value: {
          bridgeAction: "submit_plan_form",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(
      {
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
        text: "/plan 帮我先梳理这个仓库的改造方案，不要直接改代码",
      },
      expect.objectContaining({
        onProgress: expect.any(Function),
      }),
    );
    expect(card).toMatchObject({
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "计划请求已提交",
            },
          },
        },
      },
    });
  });

  it("acks /ca new immediately and patches the original card after the new thread is created", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const actionPromise = service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_new_card_1",
      action: {
        tag: "button",
        value: {
          command: "/ca new",
          chatId: "oc_chat_current",
        },
      },
    });

    const firstResult = await Promise.race([
      actionPromise.then(value => ({ type: "resolved" as const, value })),
      new Promise<{ type: "timeout" }>(resolve => setTimeout(() => resolve({ type: "timeout" }), 0)),
    ]);

    expect(firstResult.type).toBe("resolved");
    if (firstResult.type !== "resolved") {
      return;
    }

    expect(firstResult.value).toMatchObject({
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

    deferred.resolve([
      { kind: "system", text: "[ca] thread switched to thread-created" } as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith(
        "om_new_card_1",
        expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "命令结果",
            }),
          }),
        }),
      );
    });
  });

  it("acks risky thread commands immediately and patches the original card with the final card reply", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "线程已切换",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const actionPromise = service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_thread_switch_1",
      action: {
        tag: "button",
        value: {
          command: "/ca thread switch thread-native-123",
          chatId: "oc_project_chat_1",
        },
      },
    });

    const firstResult = await Promise.race([
      actionPromise.then(value => ({ type: "resolved" as const, value })),
      new Promise<{ type: "timeout" }>(resolve => setTimeout(() => resolve({ type: "timeout" }), 0)),
    ]);

    expect(firstResult.type).toBe("resolved");
    if (firstResult.type !== "resolved") {
      return;
    }

    expect(firstResult.value).toMatchObject({
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

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith("om_thread_switch_1", replyCard);
    });
  });

  it("passes group project bind buttons through the generic command callback path", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "项目已绑定",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_project_bind_1",
      action: {
        tag: "button",
        value: {
          command: "/ca project bind-current project-alpha",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project bind-current project-alpha",
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

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith("om_project_bind_1", replyCard);
    });
  });

  it("launches a stored plan choice asynchronously and returns an immediate ack card", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      handlePlanChoice: vi.fn(() => new Promise<BridgeReply[]>(() => undefined)),
      getPendingPlanInteraction: vi.fn(() => ({
        interactionId: "plan-1",
        question: "你希望我下一步先做哪件事？",
        choices: [
          {
            choiceId: "tests",
            label: "先补测试",
            responseText: "先补测试和验证路径，不要直接改代码。",
          },
        ],
      })),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: createApiClientDouble() as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_plan_choice_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "answer_plan_choice",
          interactionId: "plan-1",
          choiceId: "tests",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.getPendingPlanInteraction).toHaveBeenCalledWith("plan-1");
    expect(bridgeService.handlePlanChoice).toHaveBeenCalledWith(
      {
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
        interactionId: "plan-1",
        choiceId: "tests",
      },
      expect.objectContaining({
        onProgress: expect.any(Function),
      }),
    );
    expect(card).toMatchObject({
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "计划选项已提交",
            },
          },
        },
      },
    });
  });

  it("returns an error card when the selected pending interaction no longer exists", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      handlePlanChoice: vi.fn(async () => []),
      getPendingPlanInteraction: vi.fn(() => undefined),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: createApiClientDouble() as any,
    });

    const card = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_plan_choice_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "answer_plan_choice",
          interactionId: "plan-missing",
          choiceId: "tests",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.handlePlanChoice).not.toHaveBeenCalled();
    expect(card).toMatchObject({
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "计划交互不可用",
            },
          },
        },
      },
    });
  });
});

function createApiClientDouble() {
  return {
    sendTextMessage: vi.fn(async () => "msg-text-1"),
    sendTextMessageToChat: vi.fn(async () => ({ messageId: "msg-chat-1", threadId: "omt-1" })),
    replyTextMessage: vi.fn(async () => "msg-reply-text-1"),
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return {
    promise,
    resolve,
    reject,
  };
}
