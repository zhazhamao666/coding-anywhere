import { BRIDGE_COMMAND_PREFIX, routeBridgeInput } from "./command-router.js";
import { buildBridgeHubCard } from "./feishu-card/navigation-card-builder.js";
import { StreamingCardController } from "./feishu-card/streaming-card-controller.js";
import type { FeishuApiClientLike, StreamingCardControllerLike } from "./feishu-adapter.js";
import type { BridgeReply } from "./types.js";

interface DesktopThreadContinuationResult {
  reply: BridgeReply;
  topicReply?: {
    anchorMessageId: string;
    reply: BridgeReply;
  };
}

interface CardActionValue {
  cardId?: string;
  command?: string;
  bridgeAction?:
    | "open_plan_form"
    | "submit_plan_form"
    | "toggle_plan_mode"
    | "open_diagnostics"
    | "close_diagnostics"
    | "answer_plan_choice"
    | "continue_desktop_thread"
    | "view_desktop_thread_history"
    | "mute_desktop_thread"
    | "set_codex_model"
    | "set_reasoning_effort"
    | "set_codex_speed";
  interactionId?: string;
  choiceId?: string;
  threadId?: string;
  mode?: "dm" | "project_group" | "thread";
  chatType?: "p2p" | "group";
  chatId?: string;
  messageId?: string;
  surfaceType?: "thread";
  surfaceRef?: string;
}

export class FeishuCardActionService {
  public constructor(
    private readonly dependencies: {
      bridgeService: {
        handleMessage(input: {
          channel: string;
          peerId: string;
          text: string;
          chatType?: "p2p" | "group";
          chatId?: string;
          surfaceType?: "thread";
          surfaceRef?: string;
        }, options?: {
          onProgress?: (snapshot: any) => Promise<void> | void;
        }): Promise<BridgeReply[]>;
        handlePlanChoice?(input: {
          channel: string;
          peerId: string;
          interactionId: string;
          choiceId: string;
          chatType?: "p2p" | "group";
          chatId?: string;
          surfaceType?: "thread";
          surfaceRef?: string;
        }, options?: {
          onProgress?: (snapshot: any) => Promise<void> | void;
        }): Promise<BridgeReply[]>;
        getPendingPlanInteraction?(interactionId: string): {
          interactionId: string;
          status?: string;
        } | undefined;
        updateCodexPreferences?(input: {
          channel: string;
          peerId: string;
          chatType?: "p2p" | "group";
          chatId?: string;
          surfaceType?: "thread";
          surfaceRef?: string;
          model?: string;
          reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
          speed?: "standard" | "fast";
        }): Promise<BridgeReply>;
        handleSessionCardUiAction?(input: {
          channel: string;
          peerId: string;
          action: "toggle_plan_mode" | "open_diagnostics" | "close_diagnostics";
          chatType?: "p2p" | "group";
          chatId?: string;
          surfaceType?: "thread";
          surfaceRef?: string;
        }): Promise<BridgeReply>;
        continueDesktopThread?(input: {
          channel: string;
          peerId: string;
          threadId: string;
          mode: "dm" | "project_group" | "thread";
          chatType?: "p2p" | "group";
          chatId?: string;
          surfaceType?: "thread";
          surfaceRef?: string;
        }): Promise<DesktopThreadContinuationResult>;
      };
      apiClient?: FeishuApiClientLike;
      createStreamingCardController?: (input: {
        peerId: string;
        apiClient: FeishuApiClientLike;
        anchorMessageId?: string;
        existingMessageId?: string;
      }) => StreamingCardControllerLike;
      logger?: {
        info?: (payload: unknown, message?: string) => void;
        warn?: (payload: unknown, message?: string) => void;
        error?: (payload: unknown, message?: string) => void;
      };
    },
  ) {}

  public async handleAction(event: {
    open_id: string;
    tenant_key?: string;
    open_chat_id?: string;
    open_message_id?: string;
    token?: string;
    action?: {
      tag?: string;
      name?: string;
      option?: string;
      value?: CardActionValue;
      form_value?: Record<string, unknown>;
    };
  }): Promise<Record<string, unknown>> {
    const actionValue = event.action?.value;
    const command = actionValue?.command?.trim();
    const routedCommand = command ? routeBridgeInput(command) : undefined;
    const bridgeAction = actionValue?.bridgeAction;
    const patchTargetCardId = actionValue?.cardId;
    const patchTargetMessageId = actionValue?.messageId ?? event.open_message_id;
    const effectiveChatId = actionValue?.chatId ?? event.open_chat_id;

    if (
      bridgeAction === "set_codex_model" ||
      bridgeAction === "set_reasoning_effort" ||
      bridgeAction === "set_codex_speed"
    ) {
      const selectedOption = event.action?.option?.trim();
      if (!selectedOption || !this.dependencies.bridgeService.updateCodexPreferences) {
        return this.buildRawCardResponse(this.buildInfoCard("设置不可用", [
          "当前环境暂时无法更新 Codex 会话设置。",
        ], actionValue));
      }

      const updatedReply = await this.dependencies.bridgeService.updateCodexPreferences({
        channel: "feishu",
        peerId: event.open_id,
        chatType: actionValue?.chatType,
        chatId: effectiveChatId,
        surfaceType: actionValue?.surfaceType,
        surfaceRef: actionValue?.surfaceRef,
        ...(bridgeAction === "set_codex_model"
          ? { model: selectedOption }
          : bridgeAction === "set_reasoning_effort"
            ? { reasoningEffort: selectedOption as "minimal" | "low" | "medium" | "high" | "xhigh" }
            : { speed: selectedOption as "standard" | "fast" }),
      });

      if (updatedReply.kind === "card") {
        return this.buildRawCardResponse(updatedReply.card);
      }

      return this.buildRawCardResponse(this.buildInfoCard("设置已更新", [
        updatedReply.kind === "system" || updatedReply.kind === "assistant"
          ? updatedReply.text
          : "当前设置已更新。",
      ], actionValue));
    }

    if (
      bridgeAction === "toggle_plan_mode" ||
      bridgeAction === "open_diagnostics" ||
      bridgeAction === "close_diagnostics" ||
      bridgeAction === "open_plan_form"
    ) {
      if (!this.dependencies.bridgeService.handleSessionCardUiAction) {
        return this.buildRawCardResponse(this.buildInfoCard("当前会话不可用", [
          "当前环境暂时无法切换会话卡片状态。",
        ], actionValue));
      }

      const updatedReply = await this.dependencies.bridgeService.handleSessionCardUiAction({
        channel: "feishu",
        peerId: event.open_id,
        action: bridgeAction === "open_plan_form" ? "toggle_plan_mode" : bridgeAction,
        chatType: actionValue?.chatType,
        chatId: effectiveChatId,
        surfaceType: actionValue?.surfaceType,
        surfaceRef: actionValue?.surfaceRef,
      });

      if (updatedReply.kind === "card") {
        return this.buildRawCardResponse(updatedReply.card);
      }

      return this.buildRawCardResponse(this.buildInfoCard("当前会话不可用", [
        updatedReply.kind === "system" || updatedReply.kind === "assistant"
          ? updatedReply.text
          : "当前会话卡片暂时无法更新。",
      ], actionValue));
    }

    if (bridgeAction === "continue_desktop_thread") {
      const threadId = actionValue?.threadId?.trim();
      const mode = actionValue?.mode;
      if (!threadId || !mode || !this.dependencies.bridgeService.continueDesktopThread) {
        return this.buildRawCardResponse(this.buildInfoCard("继续入口不可用", [
          "当前环境暂时无法继续这个桌面线程。",
        ], actionValue));
      }

      const continuationResult = await this.dependencies.bridgeService.continueDesktopThread({
        channel: "feishu",
        peerId: event.open_id,
        threadId,
        mode,
        chatType: actionValue?.chatType,
        chatId: effectiveChatId,
        surfaceType: actionValue?.surfaceType,
        surfaceRef: actionValue?.surfaceRef,
      });

      const legacyHandoff = continuationResult as {
        kind?: string;
        card?: Record<string, unknown>;
        targetCard?: Record<string, unknown>;
        targetMessageId?: string;
      };
      if (
        legacyHandoff.kind === "desktop_thread_handoff" &&
        legacyHandoff.card &&
        legacyHandoff.targetCard &&
        legacyHandoff.targetMessageId
      ) {
        await this.deliverReplyToAnchor(legacyHandoff.targetMessageId, {
          kind: "card",
          card: legacyHandoff.targetCard,
        } as BridgeReply);
        return this.buildRawCardResponse(legacyHandoff.card);
      }

      const reply = isDesktopThreadContinuationResult(continuationResult)
        ? continuationResult
        : {
            reply: continuationResult as BridgeReply,
          };

      if (reply.topicReply) {
        await this.deliverReplyToAnchor(reply.topicReply.anchorMessageId, reply.topicReply.reply);
      }

      if (reply.reply.kind === "card") {
        return this.buildRawCardResponse(reply.reply.card);
      }

      return this.buildRawCardResponse(this.buildInfoCard("继续入口不可用", [
        reply.reply.kind === "system" || reply.reply.kind === "assistant"
          ? reply.reply.text
          : "当前环境暂时无法继续这个桌面线程。",
      ], actionValue));
    }

    if (bridgeAction === "view_desktop_thread_history" || bridgeAction === "mute_desktop_thread") {
      return this.buildRawCardResponse(this.buildInfoCard("功能暂未接通", [
        bridgeAction === "view_desktop_thread_history"
          ? "查看桌面线程记录稍后接入。"
          : "桌面线程静音稍后接入。",
      ], actionValue));
    }

    if (bridgeAction === "submit_plan_form") {
      const planPrompt = readTextField(event.action?.form_value, "plan_prompt");
      if (!planPrompt) {
        return this.buildRawCardResponse(this.buildInfoCard("计划模式输入为空", [
          "请先填写这次要梳理的计划请求。",
        ], actionValue));
      }

      this.launchInteractiveRun({
        peerId: event.open_id,
        anchorMessageId: patchTargetMessageId,
        execute: options => this.dependencies.bridgeService.handleMessage({
          channel: "feishu",
          peerId: event.open_id,
          chatType: actionValue?.chatType,
          chatId: effectiveChatId,
          surfaceType: actionValue?.surfaceType,
          surfaceRef: actionValue?.surfaceRef,
          text: `/plan ${planPrompt}`,
        }, options),
      });

      return this.buildToastResponse("计划请求已提交，正在启动计划模式。");
    }

    if (bridgeAction === "answer_plan_choice") {
      const interactionId = actionValue?.interactionId?.trim();
      const choiceId = actionValue?.choiceId?.trim();
      const interaction = interactionId
        ? this.dependencies.bridgeService.getPendingPlanInteraction?.(interactionId)
        : undefined;
      if (!interactionId || !choiceId || !interaction || interaction.status === "resolved") {
        return this.buildRawCardResponse(this.buildInfoCard("计划交互不可用", [
          "当前计划选择已失效，请重新发起一次计划模式。",
        ], actionValue));
      }
      if (!this.dependencies.bridgeService.handlePlanChoice) {
        return this.buildRawCardResponse(this.buildInfoCard("计划交互不可用", [
          "当前运行环境未配置计划选择处理能力。",
        ], actionValue));
      }

      this.launchInteractiveRun({
        peerId: event.open_id,
        anchorMessageId: patchTargetMessageId,
        execute: options => this.dependencies.bridgeService.handlePlanChoice?.({
          channel: "feishu",
          peerId: event.open_id,
          chatType: actionValue?.chatType,
          chatId: effectiveChatId,
          surfaceType: actionValue?.surfaceType,
          surfaceRef: actionValue?.surfaceRef,
          interactionId,
          choiceId,
        }, options) ?? Promise.resolve([]),
      });

      return this.buildToastResponse("计划选项已提交，正在继续当前计划线程。");
    }

    if (!command || !routedCommand || routedCommand.kind !== "command") {
      const invalidCard = this.buildInfoCard("无效按钮动作", [
        `仅支持 ${BRIDGE_COMMAND_PREFIX} 命令按钮回调。`,
      ]);
      this.dependencies.logger?.warn?.(
        {
          openId: event.open_id,
          openMessageId: event.open_message_id,
          command,
          actionValue,
          cardPreview: summarizeCard(invalidCard),
        },
        "feishu card action rejected",
      );
      return this.buildRawCardResponse(invalidCard);
    }

    this.dependencies.logger?.info?.(
      {
        openId: event.open_id,
        openMessageId: event.open_message_id,
        command,
        patchTargetCardId,
        patchTargetMessageId,
      },
      "feishu card action queued async command",
    );

    this.launchCommandAction({
      peerId: event.open_id,
      command,
      actionValue,
      interactionToken: event.token,
      existingMessageId: patchTargetMessageId,
      chatType: actionValue?.chatType,
      chatId: effectiveChatId,
      surfaceType: actionValue?.surfaceType,
      surfaceRef: actionValue?.surfaceRef,
      execute: () => this.dependencies.bridgeService.handleMessage({
        channel: "feishu",
        peerId: event.open_id,
        chatType: actionValue?.chatType,
        chatId: effectiveChatId,
        surfaceType: actionValue?.surfaceType,
        surfaceRef: actionValue?.surfaceRef,
        text: command,
      }),
    });

    return this.buildToastResponse(`命令已提交：${command}`);
  }

  private buildInfoCard(
    title: string,
    lines: string[],
    actionValue?: CardActionValue,
  ): Record<string, unknown> {
    return buildBridgeHubCard({
      title,
      summaryLines: [`**${title}**`, ...lines],
      sections: [],
      actions: actionValue?.chatId || actionValue?.surfaceType
        ? [{
            label: "返回导航",
            type: "primary",
            value: {
              command: BRIDGE_COMMAND_PREFIX,
              cardId: actionValue.cardId,
              chatType: actionValue.chatType,
              chatId: actionValue.chatId,
              messageId: actionValue.messageId,
              surfaceType: actionValue.surfaceType,
              surfaceRef: actionValue.surfaceRef,
            },
          }]
        : [{
            label: "返回导航",
            type: "primary",
            value: {
              command: BRIDGE_COMMAND_PREFIX,
            },
        }],
    });
  }

  private buildRawCardResponse(card: Record<string, unknown>): Record<string, unknown> {
    return {
      card: {
        type: "raw",
        data: card,
      },
    };
  }

  private buildToastResponse(content: string, type: "info" | "success" | "error" | "warning" = "info"): Record<string, unknown> {
    return {
      toast: {
        type,
        content,
      },
    };
  }

  private buildCommandResultCard(input: {
    replies: BridgeReply[];
    command: string;
    actionValue?: CardActionValue;
    openId: string;
    openMessageId?: string;
    patchTargetCardId?: string;
    patchTargetMessageId?: string;
  }): Record<string, unknown> {
    const reply = input.replies.find(item => item.kind !== "progress");
    if (!reply) {
      const emptyCard = this.buildInfoCard("命令已执行", ["没有收到可展示的结果。"], input.actionValue);
      this.dependencies.logger?.warn?.(
        {
          openId: input.openId,
          openMessageId: input.openMessageId,
          command: input.command,
          cardPreview: summarizeCard(emptyCard),
        },
        "feishu card action produced no non-progress reply",
      );
      return emptyCard;
    }

    if (reply.kind === "card") {
      this.dependencies.logger?.info?.(
        {
          openId: input.openId,
          openMessageId: input.openMessageId,
          command: input.command,
          patchTargetCardId: input.patchTargetCardId,
          patchTargetMessageId: input.patchTargetMessageId,
          cardPreview: summarizeCard(reply.card),
        },
        "feishu card action returning card reply",
      );
      return reply.card;
    }

    if (reply.kind === "image") {
      const imageLines = reply.caption
        ? [reply.caption, "图片结果已生成。"]
        : ["图片结果已生成。"];
      const infoCard = this.buildInfoCard("图片结果", imageLines, input.actionValue);
      this.dependencies.logger?.info?.(
        {
          openId: input.openId,
          openMessageId: input.openMessageId,
          command: input.command,
          replyKind: reply.kind,
          patchTargetCardId: input.patchTargetCardId,
          patchTargetMessageId: input.patchTargetMessageId,
          cardPreview: summarizeCard(infoCard),
        },
        "feishu card action wrapped image reply",
      );
      return infoCard;
    }

    const infoCard = this.buildInfoCard("命令结果", [reply.text], input.actionValue);
    this.dependencies.logger?.info?.(
      {
        openId: input.openId,
        openMessageId: input.openMessageId,
        command: input.command,
        replyKind: reply.kind,
        patchTargetCardId: input.patchTargetCardId,
        patchTargetMessageId: input.patchTargetMessageId,
        cardPreview: summarizeCard(infoCard),
      },
      "feishu card action wrapped non-card reply",
    );
    return infoCard;
  }

  private launchCommandAction(input: {
    peerId: string;
    command: string;
    actionValue?: CardActionValue;
    interactionToken?: string;
    existingMessageId?: string;
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
    execute: () => Promise<BridgeReply[]>;
  }): void {
    void (async () => {
      try {
        const replies = await input.execute();
        await this.deliverImageReplies({
          replies,
          peerId: input.peerId,
          existingMessageId: input.existingMessageId,
        });
        let card = this.buildCommandResultCard({
          replies,
          command: input.command,
          actionValue: input.actionValue,
          openId: input.peerId,
          openMessageId: input.existingMessageId,
          patchTargetCardId: input.actionValue?.cardId,
          patchTargetMessageId: input.existingMessageId,
        });
        const sessionCard = await this.maybeBuildSessionCardAfterCommand({
          command: input.command,
          replies,
          peerId: input.peerId,
          chatType: input.chatType,
          chatId: input.chatId,
          surfaceType: input.surfaceType,
          surfaceRef: input.surfaceRef,
        });
        if (sessionCard) {
          card = sessionCard;
        }
        await this.updateCommandCard(input.command, input.existingMessageId, input.interactionToken, card);
      } catch (error) {
        const errorCard = this.buildInfoCard("命令执行失败", [normalizeActionError(error)], input.actionValue);
        await this.updateCommandCard(input.command, input.existingMessageId, input.interactionToken, errorCard);
      }
    })();
  }

  private async maybeBuildSessionCardAfterCommand(input: {
    command: string;
    replies: BridgeReply[];
    peerId: string;
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  }): Promise<Record<string, unknown> | undefined> {
    const normalizedCommand = input.command.trim();
    const isNewSession = normalizedCommand === "/ca new" || normalizedCommand.startsWith("/ca new ");
    const isThreadSwitch = normalizedCommand.startsWith("/ca thread switch ");
    if (!isNewSession && !isThreadSwitch) {
      return undefined;
    }

    // Only collapse success transitions. For failures we keep the original error card.
    if (isThreadSwitch && !isSuccessfulThreadSwitchReply(input.replies)) {
      return undefined;
    }

    const replies = await this.dependencies.bridgeService.handleMessage({
      channel: "feishu",
      peerId: input.peerId,
      chatType: input.chatType,
      chatId: input.chatId,
      surfaceType: input.surfaceType,
      surfaceRef: input.surfaceRef,
      text: "/ca session",
    });
    const cardReply = replies.find(item => item.kind === "card") as Extract<BridgeReply, { kind: "card" }> | undefined;
    return cardReply?.card;
  }

  private async updateCommandCard(
    command: string,
    messageId: string | undefined,
    interactionToken: string | undefined,
    card: Record<string, unknown>,
  ): Promise<void> {
    const apiClient = this.dependencies.apiClient;
    if (interactionToken && apiClient?.delayUpdateInteractiveCard) {
      await apiClient.delayUpdateInteractiveCard({
        token: interactionToken,
        card,
      });
      this.dependencies.logger?.info?.(
        {
          command,
          interactionToken,
          cardPreview: summarizeCard(card),
        },
        "feishu async command delay-updated card",
      );
      return;
    }

    if (!messageId || !apiClient) {
      this.dependencies.logger?.warn?.(
        {
          command,
          messageId,
          hasApiClient: !!this.dependencies.apiClient,
        },
        "feishu async command completed without interactive card patch target",
      );
      return;
    }

    await apiClient.updateInteractiveCard(messageId, card);
    this.dependencies.logger?.info?.(
      {
        command,
        messageId,
        cardPreview: summarizeCard(card),
      },
      "feishu async command patched interactive card",
    );
  }

  private async deliverReplyToAnchor(anchorMessageId: string, reply: BridgeReply): Promise<void> {
    if (!this.dependencies.apiClient) {
      throw new Error("FEISHU_API_CLIENT_REQUIRED");
    }

    if (reply.kind === "card") {
      await this.dependencies.apiClient.replyInteractiveCard(anchorMessageId, reply.card);
      return;
    }

    if (reply.kind === "assistant" || reply.kind === "system") {
      await this.dependencies.apiClient.replyTextMessage(anchorMessageId, reply.text);
      return;
    }

    throw new Error("FEISHU_DESKTOP_CONTINUE_REPLY_KIND_UNSUPPORTED");
  }

  private async deliverImageReplies(input: {
    replies: BridgeReply[];
    peerId: string;
    existingMessageId?: string;
  }): Promise<void> {
    for (const reply of input.replies) {
      if (reply.kind !== "image") {
        continue;
      }

      try {
        await this.deliverImageReply({
          peerId: input.peerId,
          existingMessageId: input.existingMessageId,
          reply,
        });
      } catch (error) {
        this.dependencies.logger?.warn?.(
          {
            peerId: input.peerId,
            existingMessageId: input.existingMessageId,
            error: normalizeActionError(error),
            localPath: reply.localPath,
          },
          "feishu card action image delivery failed",
        );
      }
    }
  }

  private async deliverImageReply(input: {
    peerId: string;
    existingMessageId?: string;
    reply: Extract<BridgeReply, { kind: "image" }>;
  }): Promise<void> {
    const apiClient = this.dependencies.apiClient;
    if (!apiClient?.uploadImage) {
      throw new Error("FEISHU_IMAGE_REPLY_UNAVAILABLE");
    }

    const uploaded = await apiClient.uploadImage({ imagePath: input.reply.localPath });
    const imageKey = extractImageKey(uploaded);
    if (!imageKey) {
      throw new Error("FEISHU_IMAGE_REPLY_UNAVAILABLE");
    }

    if (input.existingMessageId && apiClient.replyImageMessage) {
      await apiClient.replyImageMessage(input.existingMessageId, imageKey);
      return;
    }

    if (apiClient.sendImageMessage) {
      await apiClient.sendImageMessage(input.peerId, imageKey);
      return;
    }

    throw new Error("FEISHU_IMAGE_REPLY_UNAVAILABLE");
  }

  private launchInteractiveRun(input: {
    peerId: string;
    anchorMessageId?: string;
    existingMessageId?: string;
    execute: (options: {
      onProgress?: (snapshot: any) => Promise<void> | void;
    }) => Promise<BridgeReply[]>;
  }): void {
    const apiClient = this.dependencies.apiClient;
    const controller = apiClient
      ? this.createStreamingCardController({
          peerId: input.peerId,
          apiClient,
          anchorMessageId: input.anchorMessageId,
          existingMessageId: input.existingMessageId,
        })
      : undefined;

    void input.execute({
      onProgress: snapshot => controller?.push(snapshot),
    }).catch(async error => {
      await controller?.finalizeError(normalizeActionError(error));
    });
  }

  private createStreamingCardController(input: {
    peerId: string;
    apiClient: FeishuApiClientLike;
    anchorMessageId?: string;
    existingMessageId?: string;
  }): StreamingCardControllerLike {
    if (this.dependencies.createStreamingCardController) {
      return this.dependencies.createStreamingCardController(input);
    }

    return new StreamingCardController(input);
  }
}

function summarizeCard(card: Record<string, unknown>): Record<string, unknown> {
  const header = card.header as { title?: { content?: string } } | undefined;
  const topLevelElements = Array.isArray(card.elements) ? card.elements : undefined;
  const bodyElements =
    !topLevelElements &&
    card.body &&
    typeof card.body === "object" &&
    Array.isArray((card.body as Record<string, unknown>).elements)
      ? ((card.body as Record<string, unknown>).elements as unknown[])
      : undefined;
  const elements = topLevelElements ?? bodyElements ?? [];
  return {
    title: header?.title?.content ?? "",
    elementCount: elements.length,
    firstElementTag: (elements[0] as { tag?: string } | undefined)?.tag ?? "",
  };
}

function isDesktopThreadContinuationResult(value: unknown): value is DesktopThreadContinuationResult {
  return !!value
    && typeof value === "object"
    && "reply" in value;
}

function isSuccessfulThreadSwitchReply(replies: BridgeReply[]): boolean {
  const reply = replies.find(item => item.kind !== "progress");
  if (!reply) {
    return false;
  }

  if (reply.kind === "system") {
    return reply.text.startsWith("[ca] thread switched to ");
  }

  if (reply.kind === "card") {
    const header = reply.card.header as { title?: { content?: string } } | undefined;
    const title = header?.title?.content?.trim() ?? "";
    return title === "线程已切换";
  }

  return false;
}

function readTextField(formValue: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = formValue?.[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function normalizeActionError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `[ca] error: ${error.message}`;
  }

  return "[ca] error: RUN_STREAM_FAILED";
}

function extractImageKey(value: { imageKey?: string; image_key?: string } | string): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  return value.imageKey?.trim() || value.image_key?.trim() || undefined;
}
