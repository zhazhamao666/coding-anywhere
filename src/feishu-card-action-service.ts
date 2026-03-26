import { BRIDGE_COMMAND_PREFIX, routeBridgeInput } from "./command-router.js";
import { buildBridgeHubCard } from "./feishu-card/navigation-card-builder.js";
import type { BridgeReply } from "./types.js";

interface CardActionValue {
  cardId?: string;
  command?: string;
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
        }): Promise<BridgeReply[]>;
      };
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
      value?: CardActionValue;
    };
  }): Promise<Record<string, unknown>> {
    const actionValue = event.action?.value;
    const command = actionValue?.command?.trim();
    const patchTargetCardId = actionValue?.cardId;
    const patchTargetMessageId = actionValue?.messageId ?? event.open_message_id;

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
