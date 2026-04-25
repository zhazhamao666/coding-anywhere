import { describe, expect, it, vi } from "vitest";

import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import type { BridgeReply, ProgressCardState } from "../src/types.js";

describe("FeishuCardActionService", () => {
  it("returns a toast for command callbacks and delay-updates the final card asynchronously", async () => {
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

    const result = await service.handleAction({
      open_id: "ou_demo",
      tenant_key: "tenant-demo",
      open_message_id: "om_card_1",
      token: "c-token-demo",
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
    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalledWith({
        token: "c-token-demo",
        card: replyCard,
      });
    });
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("falls back to open_message_id patching when no interaction token is available", async () => {
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

    const result = await service.handleAction({
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

    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith("om_callback_1", replyCard);
    });
  });

  it("falls back to open_chat_id when command callbacks omit chatId in action value", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_chat_id: "oc_group_fallback",
      open_message_id: "om_callback_2",
      token: "c-token-chat-fallback",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_group_fallback",
      text: "/ca project current",
    });
    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    deferred.resolve([
      { kind: "system", text: "[ca] current project: fallback" } as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalledWith({
        token: "c-token-chat-fallback",
        card: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "命令结果",
            }),
          }),
        }),
      });
    });
  });

  it("does not treat Feishu open_chat_id as a group context for p2p command callbacks", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    await service.handleAction({
      open_id: "ou_demo",
      open_chat_id: "oc_callback_dm_chat",
      open_message_id: "om_callback_1",
      token: "c-token-demo",
      action: {
        tag: "button",
        value: {
          command: "/ca thread list-current",
          chatType: "p2p",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      chatType: "p2p",
      text: "/ca thread list-current",
    });

    deferred.resolve([]);
    await vi.waitFor(() => {
      expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalled();
    });
  });

  it("wraps system replies in a fallback patched result card when no interaction token is available", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();
    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_message_id: "om_system_1",
      open_id: "ou_demo",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
        },
      },
    });

    expect(result).toMatchObject({
      toast: {
        type: "info",
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

  it("inline-replaces the current session card when plan mode is toggled on", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前会话已就绪",
        },
      },
      body: {
        elements: [{
          tag: "markdown",
          content: "**计划模式** [开]",
        }],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      handleSessionCardUiAction: vi.fn(async () => ({
        kind: "card",
        card: replyCard,
      })),
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
          bridgeAction: "toggle_plan_mode",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.handleSessionCardUiAction).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      action: "toggle_plan_mode",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(card).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(JSON.stringify(card)).toContain("[开]");
  });

  it("inline-replaces the current session card with diagnostics and supports close", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      handleSessionCardUiAction: vi.fn(async (input: { action: string }) => ({
        kind: "card",
        card: {
          schema: "2.0",
          header: {
            title: {
              tag: "plain_text",
              content: input.action === "open_diagnostics" ? "当前会话已就绪" : "当前会话已就绪",
            },
          },
          body: {
            elements: [{
              tag: "markdown",
              content: input.action === "open_diagnostics" ? "**上下文**" : "**计划模式** [关]",
            }],
          },
        },
      })),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: createApiClientDouble() as any,
    });

    const diagnosticsCard = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "open_diagnostics",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    const sessionCard = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "close_diagnostics",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.handleSessionCardUiAction).toHaveBeenNthCalledWith(1, {
      channel: "feishu",
      peerId: "ou_demo",
      action: "open_diagnostics",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(bridgeService.handleSessionCardUiAction).toHaveBeenNthCalledWith(2, {
      channel: "feishu",
      peerId: "ou_demo",
      action: "close_diagnostics",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(JSON.stringify(diagnosticsCard)).toContain("上下文");
    expect(JSON.stringify(sessionCard)).toContain("[关]");
  });

  it("updates Codex model from a select_static callback and returns the refreshed session card", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前会话",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      updateCodexPreferences: vi.fn(async () => ({
        kind: "card",
        card: replyCard,
      })),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: createApiClientDouble() as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "select_static",
        option: "gpt-5.4-mini",
        value: {
          bridgeAction: "set_codex_model",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.updateCodexPreferences).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
      model: "gpt-5.4-mini",
    });
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
  });

  it("updates Codex speed from a select_static callback and returns the refreshed session card", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前会话",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      updateCodexPreferences: vi.fn(async () => ({
        kind: "card",
        card: replyCard,
      })),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: createApiClientDouble() as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "select_static",
        option: "fast",
        value: {
          bridgeAction: "set_codex_speed",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.updateCodexPreferences).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
      speed: "fast",
    });
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
  });

  it("passes desktop completion surface context through to continueDesktopThread and returns the refreshed card", async () => {
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
      handleMessage: vi.fn(async () => []),
      continueDesktopThread: vi.fn(async () => ({
        reply: {
          kind: "card",
          card: replyCard,
        },
      })),
    };

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: createApiClientDouble() as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "continue_desktop_thread",
          mode: "thread",
          threadId: "thread-native-current",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
        },
      },
    });

    expect(bridgeService.continueDesktopThread).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      threadId: "thread-native-current",
      mode: "thread",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
  });

  it("posts the thread-switched card into the linked topic when continueDesktopThread returns a handoff result", async () => {
    const statusCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "已在飞书继续",
        },
      },
      body: {
        elements: [],
      },
    };
    const targetCard = {
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
      handleMessage: vi.fn(async () => []),
      continueDesktopThread: vi.fn(async () => ({
        reply: {
          kind: "card",
          card: statusCard,
        },
        topicReply: {
          anchorMessageId: "om_topic_new",
          reply: {
            kind: "card",
            card: targetCard,
          },
        },
      })),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "continue_desktop_thread",
          mode: "project_group",
          threadId: "thread-native-current",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(apiClient.replyInteractiveCard).toHaveBeenCalledWith("om_topic_new", targetCard);
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: statusCard,
      },
    });
  });

  it("submits a plan form via a fresh progress message instead of patching the clicked card", async () => {
    const bridgeService = {
      handleMessage: vi.fn(
        async (
          _input: unknown,
          options?: {
            onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
          },
        ) => {
          await options?.onProgress?.(createSnapshot({
            status: "queued",
            stage: "received",
            preview: "[ca] queued",
          }));
          return new Promise<BridgeReply[]>(() => undefined);
        },
      ),
      handlePlanChoice: vi.fn(async () => []),
      getPendingPlanInteraction: vi.fn(() => undefined),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_plan_card_1",
      token: "c-plan-token-1",
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
    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });
    await vi.waitFor(() => {
      expect(apiClient.replyInteractiveCard).toHaveBeenCalledWith(
        "om_plan_card_1",
        expect.objectContaining({
          schema: "2.0",
        }),
      );
    });
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalledWith(
      "om_plan_card_1",
      expect.anything(),
    );
  });

  it("acks /ca new with a toast and delay-updates the original card after the new thread is created", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const sessionCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前会话已就绪",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async (input: any) => {
        if (input.text === "/ca session") {
          return [{ kind: "card", card: sessionCard } as unknown as BridgeReply];
        }
        return deferred.promise;
      }),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_new_card_1",
      token: "c-new-token-1",
      action: {
        tag: "button",
        value: {
          command: "/ca new",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    deferred.resolve([
      { kind: "system", text: "[ca] thread switched to thread-created" } as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalledWith({
        token: "c-new-token-1",
        card: sessionCard,
      });
    });
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("delay-updates risky thread commands when an interaction token is available", async () => {
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
    const sessionCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前会话已就绪",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async (input: any) => {
        if (input.text === "/ca session") {
          return [{ kind: "card", card: sessionCard } as unknown as BridgeReply];
        }
        return deferred.promise;
      }),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_thread_switch_1",
      token: "c-thread-switch-1",
      action: {
        tag: "button",
        value: {
          command: "/ca thread switch thread-native-123",
          chatId: "oc_project_chat_1",
        },
      },
    });

    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalledWith({
        token: "c-thread-switch-1",
        card: sessionCard,
      });
    });
  });

  it("preserves DM callback context even when Feishu provides open_chat_id", async () => {
    const deferred = createDeferred<BridgeReply[]>();
    const bridgeService = {
      handleMessage: vi.fn(() => deferred.promise),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_chat_id: "oc_dm_card",
      open_message_id: "om_callback_dm",
      token: "c-token-dm",
      action: {
        tag: "button",
        value: {
          command: "/ca project list",
          chatId: "oc_dm_card",
          chatType: "p2p",
        } as any,
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_dm_card",
      chatType: "p2p",
      text: "/ca project list",
    }));
    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    deferred.resolve([
      { kind: "system", text: "[ca] project list: ok" } as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalledWith({
        token: "c-token-dm",
        card: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "命令结果",
            }),
          }),
        }),
      });
    });
  });

  it("passes group project bind buttons through the token-finalize command callback path", async () => {
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

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_project_bind_1",
      token: "c-project-bind-1",
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
    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    deferred.resolve([
      { kind: "card", card: replyCard } as unknown as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalledWith({
        token: "c-project-bind-1",
        card: replyCard,
      });
    });
  });

  it("launches a stored plan choice via a fresh progress message", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      handlePlanChoice: vi.fn(
        async (
          _input: unknown,
          options?: {
            onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
          },
        ) => {
          await options?.onProgress?.(createSnapshot({
            status: "waiting",
            stage: "waiting",
            preview: "等待继续当前计划线程",
          }));
          return new Promise<BridgeReply[]>(() => undefined);
        },
      ),
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
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_plan_choice_1",
      token: "c-plan-choice-1",
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
    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });
    await vi.waitFor(() => {
      expect(apiClient.replyInteractiveCard).toHaveBeenCalledWith(
        "om_plan_choice_1",
        expect.objectContaining({
          schema: "2.0",
        }),
      );
    });
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalledWith(
      "om_plan_choice_1",
      expect.anything(),
    );
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
    delayUpdateInteractiveCard: vi.fn(async () => undefined),
    updateInteractiveCard: vi.fn(async () => undefined),
    createCardEntity: vi.fn(async () => "card-1"),
    sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
    streamCardElement: vi.fn(async () => undefined),
    setCardStreamingMode: vi.fn(async () => undefined),
    updateCardKitCard: vi.fn(async () => undefined),
  };
}

function createSnapshot(overrides?: Partial<ProgressCardState>): ProgressCardState {
  return {
    runId: "run-1",
    rootName: "main",
    status: "queued",
    stage: "received",
    preview: "[ca] queued",
    startedAt: 1_000,
    elapsedMs: 0,
    ...overrides,
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
