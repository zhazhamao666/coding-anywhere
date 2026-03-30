import { BRIDGE_COMMAND_PREFIX, routeBridgeInput } from "./command-router.js";
import { buildBridgeHubCard } from "./feishu-card/navigation-card-builder.js";
import { buildPlanModeFormCard } from "./feishu-card/card-builder.js";
import { StreamingCardController } from "./feishu-card/streaming-card-controller.js";
import type { FeishuApiClientLike, StreamingCardControllerLike } from "./feishu-adapter.js";
import type { BridgeReply } from "./types.js";

interface CardActionValue {
  cardId?: string;
  command?: string;
  bridgeAction?: "open_plan_form" | "submit_plan_form" | "answer_plan_choice";
  interactionId?: string;
  choiceId?: string;
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
      };
      apiClient?: FeishuApiClientLike;
      createStreamingCardController?: (input: {
        peerId: string;
        apiClient: FeishuApiClientLike;
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
    open_message_id?: string;
    token?: string;
    action?: {
      tag?: string;
      name?: string;
      value?: CardActionValue;
      form_value?: Record<string, unknown>;
    };
  }): Promise<Record<string, unknown>> {
    const actionValue = event.action?.value;
    const command = actionValue?.command?.trim();
    const bridgeAction = actionValue?.bridgeAction;
    const patchTargetCardId = actionValue?.cardId;
    const patchTargetMessageId = actionValue?.messageId ?? event.open_message_id;

    if (bridgeAction === "open_plan_form") {
      const card = buildPlanModeFormCard({
        context: {
          chatId: actionValue?.chatId,
          surfaceType: actionValue?.surfaceType,
          surfaceRef: actionValue?.surfaceRef,
        },
      });
      return this.buildRawCardResponse(card);
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
        existingMessageId: patchTargetMessageId,
        execute: options => this.dependencies.bridgeService.handleMessage({
          channel: "feishu",
          peerId: event.open_id,
          chatId: actionValue?.chatId,
          surfaceType: actionValue?.surfaceType,
          surfaceRef: actionValue?.surfaceRef,
          text: `/plan ${planPrompt}`,
        }, options),
      });

      return this.buildRawCardResponse(this.buildInfoCard("计划请求已提交", [
        "正在启动计划模式，请稍候。",
      ], actionValue));
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
        existingMessageId: patchTargetMessageId,
        execute: options => this.dependencies.bridgeService.handlePlanChoice?.({
          channel: "feishu",
          peerId: event.open_id,
          chatId: actionValue?.chatId,
          surfaceType: actionValue?.surfaceType,
          surfaceRef: actionValue?.surfaceRef,
          interactionId,
          choiceId,
        }, options) ?? Promise.resolve([]),
      });

      return this.buildRawCardResponse(this.buildInfoCard("计划选项已提交", [
        "已根据你的选择继续当前计划线程。",
      ], actionValue));
    }

    if (!command || routeBridgeInput(command).kind !== "command") {
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

    const replies = await this.dependencies.bridgeService.handleMessage({
      channel: "feishu",
      peerId: event.open_id,
      chatId: actionValue?.chatId,
      surfaceType: actionValue?.surfaceType,
      surfaceRef: actionValue?.surfaceRef,
      text: command,
    });
    this.dependencies.logger?.info?.(
      {
        openId: event.open_id,
        openMessageId: event.open_message_id,
        command,
        replyKinds: replies.map(item => item.kind),
      },
      "feishu card action bridge replies",
    );

    const reply = replies.find(item => item.kind !== "progress");
    if (!reply) {
      const emptyCard = this.buildInfoCard("命令已执行", ["没有收到可展示的结果。"]);
      this.dependencies.logger?.warn?.(
        {
          openId: event.open_id,
          openMessageId: event.open_message_id,
          command,
          cardPreview: summarizeCard(emptyCard),
        },
        "feishu card action produced no non-progress reply",
      );
      return this.buildRawCardResponse(emptyCard);
    }

    if (reply.kind === "card") {
      this.dependencies.logger?.info?.(
        {
          openId: event.open_id,
          openMessageId: event.open_message_id,
          command,
          patchTargetCardId,
          patchTargetMessageId,
          cardPreview: summarizeCard(reply.card),
        },
        "feishu card action returning card reply",
      );
      return this.buildRawCardResponse(reply.card);
    }

    const infoCard = this.buildInfoCard("命令结果", [reply.text], actionValue);
    this.dependencies.logger?.info?.(
      {
        openId: event.open_id,
        openMessageId: event.open_message_id,
        command,
        replyKind: reply.kind,
        patchTargetCardId,
        patchTargetMessageId,
        cardPreview: summarizeCard(infoCard),
      },
      "feishu card action wrapped non-card reply",
    );
    return this.buildRawCardResponse(infoCard);
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

  private launchInteractiveRun(input: {
    peerId: string;
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
