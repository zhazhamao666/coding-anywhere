import { StreamingCardController } from "./feishu-card/streaming-card-controller.js";
import { isBridgeCommandMessage } from "./command-router.js";
import { buildFeishuInboundLog } from "./feishu-message-log.js";
import type { BridgeReply, ProgressCardState } from "./types.js";

export interface BridgeServiceLike {
  handleMessage(
    input: {
      channel: string;
      peerId: string;
      text: string;
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
    options?: {
      onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
    },
  ): Promise<BridgeReply[]>;
}

export interface FeishuApiClientLike {
  sendTextMessage(peerId: string, text: string): Promise<string>;
  sendTextMessageToChat(chatId: string, text: string): Promise<{ messageId: string; threadId: string }>;
  replyTextMessage(messageId: string, text: string): Promise<string>;
  updateTextMessage(messageId: string, text: string): Promise<void>;
  uploadImage?(input: { imagePath: string }): Promise<{ imageKey?: string; image_key?: string } | string>;
  sendImageMessage?(peerId: string, imageKey: string): Promise<string>;
  replyImageMessage?(messageId: string, imageKey: string): Promise<string>;
  sendInteractiveCard(peerId: string, card: Record<string, unknown>): Promise<string>;
  replyInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<string>;
  updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  createCardEntity(card: Record<string, unknown>): Promise<string>;
  sendCardKitMessage(peerId: string, cardId: string): Promise<string>;
  streamCardElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void>;
  setCardStreamingMode(cardId: string, streamingMode: boolean, sequence: number): Promise<void>;
  updateCardKitCard(cardId: string, card: Record<string, unknown>, sequence: number): Promise<void>;
}

export interface StreamingCardControllerLike {
  push(snapshot: ProgressCardState): Promise<void>;
  finalizeError(errorText: string): Promise<void>;
}

export interface FeishuEnvelope {
  header?: {
    event_id?: string;
  };
  event?: {
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      thread_id?: string;
      content?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
  };
}

export class FeishuAdapter {
  private readonly seenMessageKeys = new Set<string>();

  public constructor(
    private readonly dependencies: {
      allowlist: string[];
      bridgeService: BridgeServiceLike;
      apiClient: FeishuApiClientLike;
      createStreamingCardController?: (input: {
        peerId: string;
        apiClient: FeishuApiClientLike;
        anchorMessageId?: string;
      }) => StreamingCardControllerLike;
      requireGroupMention?: boolean;
      logger?: {
        info?: (message: string) => void;
      };
    },
  ) {}

  public async handleEnvelope(envelope: FeishuEnvelope): Promise<void> {
    const messageKey = getEnvelopeMessageKey(envelope);
    if (messageKey && this.seenMessageKeys.has(messageKey)) {
      return;
    }

    if (messageKey) {
      this.seenMessageKeys.add(messageKey);
    }

    const peerId = envelope.event?.sender?.sender_id?.open_id;
    const message = envelope.event?.message;
    const anchorMessageId = message?.chat_type === "group" ? message.message_id : undefined;

    if (!peerId || !this.dependencies.allowlist.includes(peerId)) {
      return;
    }

    if (!message || message.message_type !== "text") {
      return;
    }

    const parsedContent = parseFeishuTextContent(message.content);
    if (!parsedContent.text) {
      return;
    }

    const isDm = message.chat_type === "p2p";
    const isGroupThread = message.chat_type === "group" && !!message.thread_id && !!message.chat_id;
    const isGroupCommand =
      message.chat_type === "group" &&
      !!message.chat_id &&
      !message.thread_id &&
      isBridgeCommandMessage(parsedContent.text);

    if (!isDm && !isGroupThread && !isGroupCommand) {
      return;
    }

    if (
      isGroupThread &&
      this.dependencies.requireGroupMention &&
      !parsedContent.hasMention
    ) {
      return;
    }

    this.dependencies.logger?.info?.(
      buildFeishuInboundLog({
        peerId,
        chatType: message.chat_type,
        messageId: message.message_id,
        chatId: message.chat_id,
        threadId: message.thread_id,
        text: parsedContent.text,
      }),
    );

    let cardController: StreamingCardControllerLike | undefined;
    let replies: BridgeReply[];
    try {
      replies = await this.dependencies.bridgeService.handleMessage(
        isGroupThread
          ? {
              channel: "feishu",
              peerId,
              chatId: message.chat_id,
              surfaceType: "thread",
              surfaceRef: message.thread_id,
              text: parsedContent.text,
            }
          : isGroupCommand
            ? {
                channel: "feishu",
                peerId,
                chatId: message.chat_id,
                text: parsedContent.text,
              }
          : {
              channel: "feishu",
              peerId,
              text: parsedContent.text,
            },
        {
          onProgress: async snapshot => {
            cardController ??= this.createStreamingCardController(
              peerId,
              message.chat_type === "group" ? message.message_id : undefined,
            );
            await cardController.push(snapshot);
          },
        },
      );
    } catch (error) {
      const errorText = `[ca] error: ${normalizeBridgeError(error)}`;
      if (cardController) {
        await cardController.finalizeError(errorText);
      }
      await this.replyText({
        peerId,
        anchorMessageId: message.chat_type === "group" ? message.message_id : undefined,
        text: errorText,
      });
      return;
    }

    for (const reply of replies) {
      if (reply.kind === "progress") {
        continue;
      }

      if (reply.kind === "card") {
        await this.replyCard({
          peerId,
          anchorMessageId,
          card: reply.card,
        });
        continue;
      }

      if (reply.kind === "image") {
        await this.replyImage({
          peerId,
          anchorMessageId,
          reply,
        });
        continue;
      }

      await this.replyText({
        peerId,
        anchorMessageId,
        text: reply.text,
      });
    }
  }

  private createStreamingCardController(
    peerId: string,
    anchorMessageId?: string,
  ): StreamingCardControllerLike {
    if (this.dependencies.createStreamingCardController) {
      return this.dependencies.createStreamingCardController({
        peerId,
        apiClient: this.dependencies.apiClient,
        anchorMessageId,
      });
    }

    return new StreamingCardController({
      peerId,
      apiClient: this.dependencies.apiClient,
      anchorMessageId,
    });
  }

  private async replyText(input: {
    peerId: string;
    anchorMessageId?: string;
    text: string;
  }): Promise<void> {
    if (input.anchorMessageId) {
      await this.dependencies.apiClient.replyTextMessage(input.anchorMessageId, input.text);
      return;
    }

    await this.dependencies.apiClient.sendTextMessage(input.peerId, input.text);
  }

  private async replyCard(input: {
    peerId: string;
    anchorMessageId?: string;
    card: Record<string, unknown>;
  }): Promise<void> {
    if (input.anchorMessageId) {
      await this.dependencies.apiClient.replyInteractiveCard(input.anchorMessageId, input.card);
      return;
    }

    await this.dependencies.apiClient.sendInteractiveCard(input.peerId, input.card);
  }

  private async replyImage(input: {
    peerId: string;
    anchorMessageId?: string;
    reply: Extract<BridgeReply, { kind: "image" }>;
  }): Promise<void> {
    const fallbackText = formatImageFallbackText(input.reply);
    const imageKey = await this.uploadImageKey(input.reply.localPath);
    if (!imageKey) {
      await this.replyText({
        peerId: input.peerId,
        anchorMessageId: input.anchorMessageId,
        text: fallbackText,
      });
      return;
    }

    if (input.anchorMessageId && this.dependencies.apiClient.replyImageMessage) {
      await this.dependencies.apiClient.replyImageMessage(input.anchorMessageId, imageKey);
      return;
    }

    if (this.dependencies.apiClient.sendImageMessage) {
      await this.dependencies.apiClient.sendImageMessage(input.peerId, imageKey);
      return;
    }

    await this.replyText({
      peerId: input.peerId,
      anchorMessageId: input.anchorMessageId,
      text: fallbackText,
    });
  }

  private async uploadImageKey(imagePath: string): Promise<string | undefined> {
    if (!this.dependencies.apiClient.uploadImage) {
      return undefined;
    }

    const result = await this.dependencies.apiClient.uploadImage({ imagePath });
    return extractImageKey(result);
  }
}

function getEnvelopeMessageKey(envelope: FeishuEnvelope): string | undefined {
  const eventId = envelope.header?.event_id?.trim();
  if (eventId) {
    return `event:${eventId}`;
  }

  const messageId = envelope.event?.message?.message_id?.trim();
  if (messageId) {
    return `message:${messageId}`;
  }

  return undefined;
}

function normalizeBridgeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "RUN_STREAM_FAILED";
}

function extractImageKey(value: { imageKey?: string; image_key?: string } | string): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  return value.imageKey?.trim() || value.image_key?.trim() || undefined;
}

function formatImageFallbackText(reply: Extract<BridgeReply, { kind: "image" }>): string {
  return reply.caption?.trim()
    ? `图片结果：${reply.caption.trim()}`
    : "图片结果已生成。";
}

function parseFeishuTextContent(content?: string): { text?: string; hasMention: boolean } {
  if (!content) {
    return {
      text: undefined,
      hasMention: false,
    };
  }

  try {
    const parsed = JSON.parse(content) as { text?: string; mentions?: unknown[] };
    return {
      text: parsed.text?.trim() || undefined,
      hasMention: Array.isArray(parsed.mentions) ? parsed.mentions.length > 0 : false,
    };
  } catch {
    return {
      text: content.trim() || undefined,
      hasMention: false,
    };
  }
}
