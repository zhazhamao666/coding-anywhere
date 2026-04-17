import path from "node:path";

import { DEFAULT_BRIDGE_ASSET_ROOT_DIR } from "./bridge-image-directive.js";
import { StreamingCardController } from "./feishu-card/streaming-card-controller.js";
import { containsMarkdownSyntax, normalizeMarkdownToPlainText } from "./markdown-text.js";
import { isBridgeCommandMessage } from "./command-router.js";
import { buildFeishuInboundLog } from "./feishu-message-log.js";
import type {
  BridgeAssetDownloadResult,
  BridgeAssetRecord,
  BridgeReply,
  ProgressCardState,
} from "./types.js";

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
  downloadMessageResource?(input: {
    messageId: string;
    fileKey: string;
    type: "image";
    downloadDir: string;
    preferredFileName?: string;
  }): Promise<BridgeAssetDownloadResult>;
  uploadImage?(input: {
    imagePath: string;
    imageType?: "message" | "avatar";
  }): Promise<{ imageKey?: string; image_key?: string } | string>;
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

export interface PendingBridgeAssetStoreLike {
  savePendingBridgeAsset(input: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
    runId?: string | null;
    messageId: string;
    resourceType?: BridgeAssetRecord["resourceType"];
    resourceKey: string;
    localPath: string;
    fileName: string;
    mimeType?: string | null;
    fileSize?: number | null;
    createdAt?: string;
  }): BridgeAssetRecord;
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

type FeishuEnvelopeMessage = NonNullable<NonNullable<FeishuEnvelope["event"]>["message"]>;

export class FeishuAdapter {
  private readonly seenMessageKeys = new Set<string>();

  public constructor(
    private readonly dependencies: {
      allowlist: string[];
      bridgeService: BridgeServiceLike;
      apiClient: FeishuApiClientLike;
      pendingAssetStore?: PendingBridgeAssetStoreLike;
      createStreamingCardController?: (input: {
        peerId: string;
        apiClient: FeishuApiClientLike;
        anchorMessageId?: string;
      }) => StreamingCardControllerLike;
      inboundAssetRootDir?: string;
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

    if (!message) {
      return;
    }

    if (message.message_type === "image") {
      try {
        await this.handleInboundImage({
          peerId,
          message,
        });
      } catch (error) {
        await this.replyText({
          peerId,
          anchorMessageId: message.chat_type === "group" ? message.message_id : undefined,
          text: `[ca] error: ${normalizeBridgeError(error)}`,
        });
      }
      return;
    }

    if (message.message_type !== "text") {
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

      if (reply.kind === "assistant") {
        await this.replyAssistant({
          peerId,
          anchorMessageId,
          text: reply.text,
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

  private async handleInboundImage(input: {
    peerId: string;
    message: FeishuEnvelopeMessage;
  }): Promise<void> {
    const message = input.message;
    const imageKey = parseFeishuImageContent(message.content);
    if (!imageKey || !message.message_id) {
      return;
    }

    const isDm = message.chat_type === "p2p";
    const isGroupSurface = message.chat_type === "group" && !!message.chat_id;
    if (!isDm && !isGroupSurface) {
      return;
    }

    this.dependencies.logger?.info?.(
      buildFeishuInboundLog({
        peerId: input.peerId,
        chatType: message.chat_type,
        messageId: message.message_id,
        chatId: message.chat_id,
        threadId: message.thread_id,
        text: `[image:${imageKey}]`,
      }),
    );

    const download = await this.requireDownloadClient().downloadMessageResource({
      messageId: message.message_id,
      fileKey: imageKey,
      type: "image",
      downloadDir: buildInboundImageDownloadDir(
        this.dependencies.inboundAssetRootDir,
        input.peerId,
        message,
      ),
      preferredFileName: `${sanitizePathSegment(message.message_id)}-${sanitizePathSegment(imageKey)}.bin`,
    });

    this.requirePendingAssetStore().savePendingBridgeAsset({
      channel: "feishu",
      peerId: input.peerId,
      chatId: message.chat_id ?? null,
      surfaceType: message.thread_id ? "thread" : null,
      surfaceRef: message.thread_id ?? null,
      runId: null,
      messageId: message.message_id,
      resourceType: "image",
      resourceKey: imageKey,
      localPath: download.localPath,
      fileName: download.fileName,
      mimeType: download.mimeType,
      fileSize: download.fileSize,
    });

    await this.replyText({
      peerId: input.peerId,
      anchorMessageId: message.chat_type === "group" ? message.message_id : undefined,
      text: INBOUND_IMAGE_ACK_TEXT,
    });
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

  private async replyAssistant(input: {
    peerId: string;
    anchorMessageId?: string;
    text: string;
  }): Promise<void> {
    const markdownCard = buildAssistantMarkdownCard(input.text);
    if (markdownCard) {
      await this.replyCard({
        peerId: input.peerId,
        anchorMessageId: input.anchorMessageId,
        card: markdownCard,
      });
      return;
    }

    await this.replyText({
      peerId: input.peerId,
      anchorMessageId: input.anchorMessageId,
      text: normalizeAssistantPlainText(input.text),
    });
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

  private requirePendingAssetStore(): PendingBridgeAssetStoreLike {
    if (!this.dependencies.pendingAssetStore) {
      throw new Error("PENDING_BRIDGE_ASSET_STORE_UNAVAILABLE");
    }

    return this.dependencies.pendingAssetStore;
  }

  private requireDownloadClient(): Required<Pick<FeishuApiClientLike, "downloadMessageResource">> {
    if (!this.dependencies.apiClient.downloadMessageResource) {
      throw new Error("FEISHU_MESSAGE_RESOURCE_UNAVAILABLE");
    }

    return {
      downloadMessageResource: this.dependencies.apiClient.downloadMessageResource,
    };
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

function buildAssistantMarkdownCard(text: string): Record<string, unknown> | undefined {
  if (!shouldRenderAssistantAsMarkdownCard(text)) {
    return undefined;
  }

  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const card = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildAssistantSummary(normalized),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: "完整回复",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: normalized,
        },
      ],
    },
  } satisfies Record<string, unknown>;

  return Buffer.byteLength(JSON.stringify(card), "utf8") <= FEISHU_INTERACTIVE_CARD_MAX_BYTES
    ? card
    : undefined;
}

function shouldRenderAssistantAsMarkdownCard(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  if (normalized.length <= 120 && !containsMarkdownSyntax(normalized)) {
    return false;
  }

  return containsMarkdownSyntax(normalized) || normalized.includes("\n");
}

function buildAssistantSummary(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) ?? "完整回复";
  return firstLine.slice(0, 120);
}

function normalizeAssistantPlainText(text: string): string {
  return normalizeMarkdownToPlainText(text);
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

const FEISHU_INTERACTIVE_CARD_MAX_BYTES = 30 * 1024;

function parseFeishuImageContent(content?: string): string | undefined {
  if (!content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as { image_key?: string };
    return parsed.image_key?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function buildInboundImageDownloadDir(
  rootDir: string | undefined,
  peerId: string,
  message: FeishuEnvelopeMessage,
): string {
  return path.join(
    rootDir ?? DEFAULT_INBOUND_ASSET_ROOT_DIR,
    "feishu-inbound",
    sanitizePathSegment(message.chat_type ?? "unknown"),
    sanitizePathSegment(peerId),
    sanitizePathSegment(message.chat_id ?? "direct"),
    sanitizePathSegment(message.thread_id ?? "main"),
    sanitizePathSegment(message.message_id ?? "message"),
  );
}

function sanitizePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

const INBOUND_IMAGE_ACK_TEXT = "[ca] 已收到图片，请继续发送文字说明。";
const DEFAULT_INBOUND_ASSET_ROOT_DIR = DEFAULT_BRIDGE_ASSET_ROOT_DIR;
