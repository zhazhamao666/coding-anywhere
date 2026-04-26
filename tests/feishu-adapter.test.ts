import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import { FeishuAdapter } from "../src/feishu-adapter.js";
import type { BridgeAssetRecord, BridgeReply, ProgressCardState } from "../src/types.js";

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
      expect.objectContaining({
        channel: "feishu",
        chatType: "p2p",
        peerId: "ou_demo",
        text: "你好，codex",
      }),
      expect.objectContaining({
        onProgress: expect.any(Function),
      }),
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

  it("accepts DM messages from any user when allowlist is empty", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [{ kind: "assistant", text: "未配置 allowlist 也可使用" } satisfies BridgeReply]),
    };
    const apiClient = createApiClientDouble();

    const adapter = new FeishuAdapter({
      allowlist: [],
      bridgeService,
      apiClient,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-allowlist-open",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_anyone",
          },
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        chatType: "p2p",
        peerId: "ou_anyone",
        text: "hello",
      }),
      expect.objectContaining({
        onProgress: expect.any(Function),
      }),
    );
    expect(apiClient.sendTextMessage).toHaveBeenCalledWith("ou_anyone", "未配置 allowlist 也可使用");
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

  it("forwards plain text from a registered project group chat without requiring a thread surface", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [{ kind: "assistant", text: "收到群聊消息" } satisfies BridgeReply]),
    };
    const apiClient = createApiClientDouble();

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
      isCodexGroupChat: chatId => chatId === "oc_chat_bound",
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-group-plain-1",
      },
      event: {
        message: {
          message_id: "om_group_plain_1",
          chat_id: "oc_chat_bound",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "继续这个群里的线程" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(bridgeService.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        peerId: "ou_demo",
        chatType: "group",
        chatId: "oc_chat_bound",
        text: "继续这个群里的线程",
      }),
      expect.objectContaining({
        onProgress: expect.any(Function),
      }),
    );
    expect(apiClient.replyTextMessage).toHaveBeenCalledWith("om_group_plain_1", "收到群聊消息");
  });

  it("still ignores plain text from an unrelated group chat", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [{ kind: "assistant", text: "不应触发" } satisfies BridgeReply]),
    };
    const apiClient = createApiClientDouble();

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
      isCodexGroupChat: () => false,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-group-plain-2",
      },
      event: {
        message: {
          message_id: "om_group_plain_2",
          chat_id: "oc_chat_other",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "这条消息不应进入 Codex" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(bridgeService.handleMessage).not.toHaveBeenCalled();
    expect(apiClient.replyTextMessage).not.toHaveBeenCalled();
  });

  it("downloads inbound DM images, stages them, and replies with an acknowledgment", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-adapter-image-"));

    try {
      const bridgeService = {
        handleMessage: vi.fn(async () => [] satisfies BridgeReply[]),
      };
      const apiClient = createApiClientDouble({
        downloadMessageResource: vi.fn(async () => ({
          resourceKey: "img_dm_1",
          localPath: path.join(rootDir, "img_dm_1.png"),
          fileName: "img_dm_1.png",
          mimeType: "image/png",
          fileSize: 2048,
        })),
      });
      const pendingAssetStore = createPendingAssetStoreDouble();

      const adapter = new FeishuAdapter({
        allowlist: ["ou_demo"],
        bridgeService,
        apiClient,
        pendingAssetStore,
        inboundAssetRootDir: rootDir,
      });

      await adapter.handleEnvelope({
        header: {
          event_id: "evt-image-1",
        },
        event: {
          message: {
            message_id: "om_image_1",
            chat_type: "p2p",
            message_type: "image",
            content: JSON.stringify({ image_key: "img_dm_1" }),
          },
          sender: {
            sender_id: {
              open_id: "ou_demo",
            },
          },
        },
      });

      expect(bridgeService.handleMessage).not.toHaveBeenCalled();
      expect(apiClient.downloadMessageResource).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "om_image_1",
          fileKey: "img_dm_1",
          type: "image",
          downloadDir: expect.stringContaining(rootDir),
        }),
      );
      expect(pendingAssetStore.savePendingBridgeAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "feishu",
          peerId: "ou_demo",
          chatId: null,
          surfaceType: null,
          surfaceRef: null,
          messageId: "om_image_1",
          resourceType: "image",
          resourceKey: "img_dm_1",
          localPath: path.join(rootDir, "img_dm_1.png"),
          fileName: "img_dm_1.png",
          mimeType: "image/png",
          fileSize: 2048,
        }),
      );
      expect(apiClient.sendTextMessage).toHaveBeenCalledWith(
        "ou_demo",
        "[ca] 已收到图片，请继续发送文字说明。",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("preserves api client method context when downloading inbound images", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-adapter-image-bound-"));

    try {
      const bridgeService = {
        handleMessage: vi.fn(async () => [] satisfies BridgeReply[]),
      };
      const downloadState = {
        calls: [] as Array<{
          messageId: string;
          fileKey: string;
          type: "image";
          downloadDir: string;
          preferredFileName?: string;
        }>,
      };
      const apiClient = {
        ...createApiClientDouble(),
        downloadState,
        async downloadMessageResource(input: {
          messageId: string;
          fileKey: string;
          type: "image";
          downloadDir: string;
          preferredFileName?: string;
        }) {
          this.downloadState.calls.push(input);
          return {
            resourceKey: input.fileKey,
            localPath: path.join(rootDir, `${input.fileKey}.png`),
            fileName: `${input.fileKey}.png`,
            mimeType: "image/png",
            fileSize: 1024,
          };
        },
      };
      const pendingAssetStore = createPendingAssetStoreDouble();

      const adapter = new FeishuAdapter({
        allowlist: ["ou_demo"],
        bridgeService,
        apiClient,
        pendingAssetStore,
        inboundAssetRootDir: rootDir,
      });

      await adapter.handleEnvelope({
        header: {
          event_id: "evt-image-bound-1",
        },
        event: {
          message: {
            message_id: "om_image_bound_1",
            chat_type: "p2p",
            message_type: "image",
            content: JSON.stringify({ image_key: "img_bound_1" }),
          },
          sender: {
            sender_id: {
              open_id: "ou_demo",
            },
          },
        },
      });

      expect(apiClient.downloadState.calls).toEqual([
        expect.objectContaining({
          messageId: "om_image_bound_1",
          fileKey: "img_bound_1",
          type: "image",
        }),
      ]);
      expect(apiClient.sendTextMessage).toHaveBeenCalledWith(
        "ou_demo",
        "[ca] 已收到图片，请继续发送文字说明。",
      );
      expect(pendingAssetStore.savePendingBridgeAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceKey: "img_bound_1",
          fileName: "img_bound_1.png",
        }),
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("replies with an explicit CA error when inbound image download fails", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [] satisfies BridgeReply[]),
    };
    const apiClient = createApiClientDouble({
      downloadMessageResource: vi.fn(async () => {
        throw new Error("FEISHU_DOWNLOAD_FAILED");
      }),
    });
    const pendingAssetStore = createPendingAssetStoreDouble();

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
      pendingAssetStore,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-image-fail-1",
      },
      event: {
        message: {
          message_id: "om_image_fail_1",
          chat_type: "p2p",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_dm_fail_1" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(bridgeService.handleMessage).not.toHaveBeenCalled();
    expect(pendingAssetStore.savePendingBridgeAsset).not.toHaveBeenCalled();
    expect(apiClient.sendTextMessage).toHaveBeenCalledWith(
      "ou_demo",
      "[ca] error: FEISHU_DOWNLOAD_FAILED",
    );
  });

  it("uploads outbound image replies for DM messages", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [
        { kind: "assistant", text: "结果如下" } satisfies BridgeReply,
        { kind: "image", localPath: "D:/tmp/result.png" } satisfies BridgeReply,
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
        event_id: "evt-image-reply-dm-1",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "请返回结果图" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(apiClient.sendTextMessage).toHaveBeenCalledWith("ou_demo", "结果如下");
    expect(apiClient.uploadImage).toHaveBeenCalledWith({
      imagePath: "D:/tmp/result.png",
    });
    expect(apiClient.sendImageMessage).toHaveBeenCalledWith("ou_demo", "img-uploaded-1");
    expect(apiClient.replyImageMessage).not.toHaveBeenCalled();
  });

  it("renders markdown-heavy assistant replies as interactive cards instead of raw text", async () => {
    const bridgeService = {
      handleMessage: vi.fn(async () => [{
        kind: "assistant",
        text: [
          "**明确待办**",
          "- 清理工作区里未提交的两个本地文件",
          "- 清理历史产物目录里遗留的旧包",
        ].join("\n"),
      } satisfies BridgeReply]),
    };
    const apiClient = createApiClientDouble();

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-assistant-card-1",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "请总结当前待办" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(apiClient.sendInteractiveCard).toHaveBeenCalledWith(
      "ou_demo",
      expect.objectContaining({
        schema: "2.0",
        config: expect.objectContaining({
          summary: expect.objectContaining({
            content: "明确待办",
          }),
        }),
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "完整回复",
          }),
        }),
        body: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              tag: "markdown",
              content: expect.stringContaining("**明确待办**"),
            }),
          ]),
        }),
      }),
    );
    expect(apiClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it("falls back to cleaned plain text when assistant markdown is too large for an interactive card", async () => {
    const oversizedMarkdown = `**明确待办**\n${"- 继续整理这条超长任务说明。\n".repeat(2_500)}`;
    const bridgeService = {
      handleMessage: vi.fn(async () => [{
        kind: "assistant",
        text: oversizedMarkdown,
      } satisfies BridgeReply]),
    };
    const apiClient = createApiClientDouble();

    const adapter = new FeishuAdapter({
      allowlist: ["ou_demo"],
      bridgeService,
      apiClient,
    });

    await adapter.handleEnvelope({
      header: {
        event_id: "evt-assistant-fallback-1",
      },
      event: {
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "请返回完整回复" }),
        },
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
      },
    });

    expect(apiClient.sendInteractiveCard).not.toHaveBeenCalled();
    expect(apiClient.sendTextMessage).toHaveBeenCalledWith(
      "ou_demo",
      expect.not.stringContaining("**明确待办**"),
    );
    expect(apiClient.sendTextMessage).toHaveBeenCalledWith(
      "ou_demo",
      expect.stringContaining("• 继续整理这条超长任务说明。"),
    );
  });

  it("hides git directives from assistant replies and appends a compact file-change summary", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "feishu-adapter-git-directives-"));
    try {
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.name", "Codex Test"]);
      git(repoDir, ["config", "user.email", "codex@example.com"]);
      writeFileSync(path.join(repoDir, "alpha.txt"), "alpha\n", "utf8");
      writeFileSync(path.join(repoDir, "beta.txt"), "beta\n", "utf8");
      git(repoDir, ["add", "alpha.txt", "beta.txt"]);
      git(repoDir, ["commit", "-m", "feat: add files"]);

      const bridgeService = {
        handleMessage: vi.fn(async () => [{
          kind: "assistant",
          text: [
            "都通过了。当前分支就是 main，提交是 abc123。",
            `::git-stage{cwd="${repoDir.replace(/\\/g, "/")}"}`,
            `::git-commit{cwd="${repoDir.replace(/\\/g, "/")}"}`,
          ].join("\n"),
        } satisfies BridgeReply]),
      };
      const apiClient = createApiClientDouble();

      const adapter = new FeishuAdapter({
        allowlist: ["ou_demo"],
        bridgeService,
        apiClient,
      });

      await adapter.handleEnvelope({
        header: {
          event_id: "evt-assistant-git-directives-1",
        },
        event: {
          message: {
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "请整理最后结果" }),
          },
          sender: {
            sender_id: {
              open_id: "ou_demo",
            },
          },
        },
      });

      const serialized = extractAssistantVisiblePayload(apiClient);
      expect(serialized).toContain("2 个文件已更改");
      expect(serialized).toContain("都通过了。当前分支就是 main，提交是 abc123。");
      expect(serialized).not.toContain("::git-stage");
      expect(serialized).not.toContain("::git-commit");
      expect(serialized).not.toContain("alpha.txt");
      expect(serialized).not.toContain("beta.txt");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
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

    const response = await service.handleAction({
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

    expect(response).toMatchObject({
      toast: {
        type: "info",
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
    savePendingBridgeAsset: vi.fn((input: Record<string, unknown>) =>
      ({
        assetId: "asset-1",
        runId: null,
        channel: "feishu",
        peerId: "ou_demo",
        chatId: null,
        surfaceType: null,
        surfaceRef: null,
        messageId: "om_1",
        resourceType: "image",
        resourceKey: "img_1",
        localPath: "D:/tmp/img_1.png",
        fileName: "img_1.png",
        mimeType: "image/png",
        fileSize: 1024,
        status: "pending",
        errorText: null,
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:00:00.000Z",
        consumedAt: null,
        failedAt: null,
        expiredAt: null,
        ...input,
      }) as BridgeAssetRecord,
    ),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

function extractAssistantVisiblePayload(apiClient: ReturnType<typeof createApiClientDouble>): string {
  const cardCalls = apiClient.sendInteractiveCard.mock.calls as unknown[][];
  const textCalls = apiClient.sendTextMessage.mock.calls as unknown[][];
  const card = cardCalls[0]?.[1];
  if (card) {
    return JSON.stringify(card);
  }

  return typeof textCalls[0]?.[1] === "string" ? textCalls[0][1] : "";
}
