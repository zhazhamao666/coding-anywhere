import { describe, expect, it, vi } from "vitest";

import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import type { BridgeReply, ProgressCardState } from "../src/types.js";

describe("FeishuCardActionService", () => {
  it("inline-returns raw cards for navigation command callbacks", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前项目",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      token: "c-token-demo",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project current",
    }));
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(JSON.stringify(result)).not.toContain("命令已提交");
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("returns a lightweight new-session toast without exposing the command", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前项目已选择",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
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

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca new",
    }));
    expect(result).toMatchObject({
      toast: {
        type: "info",
        content: "已准备新会话，下一条消息将开启新的 Codex 会话。",
      },
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(JSON.stringify(result)).not.toContain("/ca new");
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("inline-returns raw cards for status command callbacks", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "运行状态",
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
          command: "/ca status",
          chatId: "oc_chat_current",
          cardId: "card-1",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca status",
    }));
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(JSON.stringify(result)).not.toContain("命令已提交");
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateCardKitCard).not.toHaveBeenCalled();
  });

  it("inline-runs session command callbacks before returning the raw card", async () => {
    const replyCard = {
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
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_card_deferred",
      token: "c-token-deferred",
      action: {
        tag: "button",
        value: {
          command: "/ca session",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca session",
    }));
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("inline-returns raw cards even when no interaction token is available", async () => {
    const replyCard = {
      schema: "2.0",
      config: {
        update_multi: true,
      },
      header: {
        title: {
          tag: "plain_text",
          content: "当前项目",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_message_id: "om_callback_1",
      open_id: "ou_demo",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project current",
    }));
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("delivers file resources from inline command action replies", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "assistant", text: "结果文件如下" } as BridgeReply,
        {
          kind: "file",
          localPath: "D:/tmp/report.md",
          fileName: "report.md",
          caption: "Markdown 预览源文件",
          presentation: "markdown_preview",
        } as BridgeReply,
      ]),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
      open_message_id: "om_callback_1",
      open_id: "ou_demo",
      action: {
        tag: "button",
        value: {
          command: "/ca project current",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(apiClient.uploadFile).toHaveBeenCalledWith({
      filePath: "D:/tmp/report.md",
      fileName: "report.md",
      fileType: undefined,
      duration: undefined,
    });
    expect(apiClient.replyFileMessage).toHaveBeenCalledWith("om_callback_1", "file-uploaded-1");
    expect(apiClient.sendFileMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      card: {
        type: "raw",
      },
    });
  });

  it("inline-returns fallback result cards when command callbacks omit chatId in action value", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "system", text: "[ca] current project: fallback" } as BridgeReply,
      ]),
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

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_group_fallback",
      text: "/ca project current",
    }));
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "命令结果",
            }),
          }),
        }),
      },
    });
    expect(JSON.stringify(result)).toContain("[ca] current project: fallback");
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("does not treat Feishu open_chat_id as a group context for p2p command callbacks", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [] satisfies BridgeReply[]),
    };
    const apiClient = createApiClientDouble();

    const service = new FeishuCardActionService({
      bridgeService: bridgeService as any,
      apiClient: apiClient as any,
    });

    const result = await service.handleAction({
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

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatType: "p2p",
      text: "/ca thread list-current",
    }));
    const handleMessageCalls = bridgeService.handleMessage.mock.calls as unknown as Array<[{
      chatId?: string;
    }]>;
    const messageInput = handleMessageCalls[0]![0];
    expect(messageInput?.chatId).toBeUndefined();
    expect(result).toMatchObject({
      card: {
        type: "raw",
      },
    });
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("wraps system replies in an inline raw result card when no interaction token is available", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "system", text: "[ca] current project: none" } as BridgeReply,
      ]),
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
      card: {
        type: "raw",
        data: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "命令结果",
            }),
          }),
        }),
      },
    });
    expect(JSON.stringify(result)).toContain("[ca] current project: none");
    expect(JSON.stringify(result)).toContain("\"command\":\"/ca\"");
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
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

  it("does not infer group context for legacy DM preference callbacks that only carry bridgeAction", async () => {
    const replyCard = {
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
      open_chat_id: "oc_dm_callback_context",
      open_message_id: "om_legacy_dm_session_card",
      action: {
        tag: "select_static",
        option: "gpt-5.4-mini",
        value: {
          bridgeAction: "set_codex_model",
        },
      },
    });

    expect(bridgeService.updateCodexPreferences).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      chatType: undefined,
      chatId: undefined,
      surfaceType: undefined,
      surfaceRef: undefined,
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

  it("returns an unsupported card for legacy Feishu topic continuation mode", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      continueDesktopThread: vi.fn(async () => ({
        reply: {
          kind: "system",
          text: "[ca] 当前不支持飞书主题入口。请在 DM 或已绑定项目群主时间线继续使用。",
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
      chatType: "group",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "继续入口不可用",
            }),
          }),
        }),
      },
    });
    expect(JSON.stringify(result)).toContain("不支持飞书主题入口");
    expect(apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("does not post legacy topicReply handoff results for project-group continuation", async () => {
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

    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: statusCard,
      },
    });
    expect(apiClient.replyInteractiveCard).not.toHaveBeenCalledWith("om_topic_new", targetCard);
    expect(apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("delivers file replies returned by desktop continuation to the clicked message anchor", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => []),
      continueDesktopThread: vi.fn(async () => ({
        reply: {
          kind: "file",
          localPath: "D:/tmp/desktop-report.md",
          fileName: "desktop-report.md",
          caption: "桌面继续结果",
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
      open_message_id: "om_continue_file_1",
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

    expect(bridgeService.continueDesktopThread).toHaveBeenCalledWith({
      channel: "feishu",
      peerId: "ou_demo",
      threadId: "thread-native-current",
      mode: "project_group",
      chatType: "group",
      chatId: "oc_chat_current",
      surfaceType: undefined,
      surfaceRef: undefined,
    });
    expect(apiClient.uploadFile).toHaveBeenCalledWith({
      filePath: "D:/tmp/desktop-report.md",
      fileName: "desktop-report.md",
      fileType: undefined,
      duration: undefined,
    });
    expect(apiClient.replyFileMessage).toHaveBeenCalledWith("om_continue_file_1", "file-uploaded-1");
    expect(apiClient.sendFileMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("继续入口不可用");
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({
              content: "文件结果",
            }),
          }),
        }),
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

    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });
    expect(bridgeService.handleMessage).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(bridgeService.handleMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "feishu",
          peerId: "ou_demo",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
          text: "/plan 帮我先梳理这个仓库的改造方案，不要直接改代码",
        }),
        expect.objectContaining({
          onProgress: expect.any(Function),
        }),
      );
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

  it("acks /ca new with a toast and inline-returns the project entry card", async () => {
    const projectEntryCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "当前项目已选择",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "card", card: projectEntryCard } as unknown as BridgeReply,
      ]),
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
        content: "已准备新会话，下一条消息将开启新的 Codex 会话。",
      },
      card: {
        type: "raw",
        data: projectEntryCard,
      },
    });
    expect(JSON.stringify(result)).not.toContain("/ca new");
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("inline-returns raw cards for thread switch callbacks", async () => {
    const replyCard = {
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
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
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
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(JSON.stringify(result)).not.toContain("命令已提交");
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it("preserves DM callback context even when Feishu provides open_chat_id", async () => {
    const replyCard = {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "项目列表",
        },
      },
      body: {
        elements: [],
      },
    };
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "card", card: replyCard } as unknown as BridgeReply,
      ]),
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

    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: replyCard,
      },
    });
    expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_dm_card",
      chatType: "p2p",
      text: "/ca project list",
    }));
    expect(apiClient.delayUpdateInteractiveCard).not.toHaveBeenCalled();
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

    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });
    expect(bridgeService.handleMessage).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(bridgeService.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        text: "/ca project bind-current project-alpha",
      }));
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

  it("delivers file resources from async command action replies", async () => {
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
      open_message_id: "om_async_file_1",
      token: "c-async-file-1",
      action: {
        tag: "button",
        value: {
          command: "/ca project bind-current project-alpha",
          chatId: "oc_chat_current",
        },
      },
    });

    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });

    await vi.waitFor(() => {
      expect(bridgeService.handleMessage).toHaveBeenCalled();
    });

    deferred.resolve([
      { kind: "assistant", text: "结果文件如下" } as BridgeReply,
      {
        kind: "file",
        localPath: "D:/tmp/report.md",
        fileName: "report.md",
      } as BridgeReply,
    ]);

    await vi.waitFor(() => {
      expect(apiClient.uploadFile).toHaveBeenCalledWith({
        filePath: "D:/tmp/report.md",
        fileName: "report.md",
        fileType: undefined,
        duration: undefined,
      });
    });
    expect(apiClient.replyFileMessage).toHaveBeenCalledWith("om_async_file_1", "file-uploaded-1");
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
            preview: "等待继续当前计划",
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
    expect(result).toMatchObject({
      toast: {
        type: "info",
      },
    });
    expect(bridgeService.handlePlanChoice).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(bridgeService.handlePlanChoice).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "feishu",
          peerId: "ou_demo",
          chatId: "oc_chat_current",
          surfaceType: "thread",
          surfaceRef: "omt_current",
          interactionId: "plan-1",
          choiceId: "tests",
        }),
        expect.objectContaining({
          onProgress: expect.any(Function),
        }),
      );
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
    uploadImage: vi.fn(async () => "img-uploaded-1"),
    sendImageMessage: vi.fn(async () => "msg-image-1"),
    replyImageMessage: vi.fn(async () => "msg-reply-image-1"),
    uploadFile: vi.fn(async () => "file-uploaded-1"),
    sendFileMessage: vi.fn(async () => "msg-file-1"),
    replyFileMessage: vi.fn(async () => "msg-reply-file-1"),
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
