import { statSync } from "node:fs";
import path from "node:path";

import { DEFAULT_BRIDGE_ASSET_ROOT_DIR } from "./bridge-image-directive.js";
import type { FeishuBridgeFileType } from "./bridge-asset-directive.js";
import { resolveFeishuAssistantMessageDelivery } from "./feishu-assistant-message.js";
import { StreamingCardController } from "./feishu-card/streaming-card-controller.js";
import { normalizeMarkdownToPlainText } from "./markdown-text.js";
import { isBridgeCommandMessage } from "./command-router.js";
import { buildFeishuInboundLog } from "./feishu-message-log.js";
import { formatFeishuCaErrorText, formatFeishuErrorText } from "./feishu-error-text.js";
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
      chatType?: "p2p" | "group";
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
    type: "image" | "file";
    downloadDir: string;
    preferredFileName?: string;
  }): Promise<BridgeAssetDownloadResult>;
  uploadImage?(input: {
    imagePath: string;
    imageType?: "message" | "avatar";
  }): Promise<{ imageKey?: string; image_key?: string } | string>;
  sendImageMessage?(peerId: string, imageKey: string): Promise<string>;
  replyImageMessage?(messageId: string, imageKey: string): Promise<string>;
  uploadFile?(input: {
    filePath: string;
    fileName?: string;
    fileType?: FeishuBridgeFileType;
    duration?: number;
  }): Promise<string>;
  sendFileMessage?(peerId: string, fileKey: string): Promise<string>;
  replyFileMessage?(messageId: string, fileKey: string): Promise<string>;
  sendInteractiveCard(peerId: string, card: Record<string, unknown>): Promise<string>;
  sendInteractiveCardToChat?(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<{ messageId: string; threadId: string }>;
  replyInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<string>;
  delayUpdateInteractiveCard?(input: {
    token: string;
    card: Record<string, unknown>;
  }): Promise<void>;
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
      mentions?: FeishuMention[];
    };
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
  };
}

type FeishuEnvelopeMessage = NonNullable<NonNullable<FeishuEnvelope["event"]>["message"]>;

interface FeishuMention {
  key?: string;
  mentioned_type?: string;
}

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
      isCodexGroupChat?: (chatId: string) => boolean;
      requireGroupMention?: boolean;
      recordDmPeer?: (input: {
        channel: string;
        peerId: string;
      }) => void;
      logger?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
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

    const enforceAllowlist = this.dependencies.allowlist.length > 0;
    if (!peerId || (enforceAllowlist && !this.dependencies.allowlist.includes(peerId))) {
      return;
    }

    if (!message) {
      return;
    }

    if (message.chat_type === "p2p") {
      this.dependencies.recordDmPeer?.({
        channel: "feishu",
        peerId,
      });
    }

    if (message.chat_type === "group" && message.thread_id) {
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
          text: formatFeishuCaErrorText(error),
        });
      }
      return;
    }

    if (message.message_type === "file") {
      try {
        await this.handleInboundFile({
          peerId,
          message,
        });
      } catch (error) {
        await this.replyText({
          peerId,
          anchorMessageId: message.chat_type === "group" ? message.message_id : undefined,
          text: formatFeishuCaErrorText(error),
        });
      }
      return;
    }

    if (message.message_type !== "text") {
      return;
    }

    const parsedContent = parseFeishuTextContent(message.content);
    const normalizedText = normalizeFeishuTextForRouting({
      text: parsedContent.text,
      chatType: message.chat_type,
      messageMentions: message.mentions,
      contentMentions: parsedContent.mentions,
      requireGroupMention: Boolean(this.dependencies.requireGroupMention),
    });
    if (!normalizedText.text) {
      return;
    }

    const normalizedChatType = message.chat_type === "p2p" || message.chat_type === "group"
      ? message.chat_type
      : undefined;
    const isDm = message.chat_type === "p2p";
    const isRegisteredGroupChat =
      message.chat_type === "group" &&
      !!message.chat_id &&
      (this.dependencies.isCodexGroupChat?.(message.chat_id) ?? false);
    const isGroupCommand =
      message.chat_type === "group" &&
      !!message.chat_id &&
      isBridgeCommandMessage(normalizedText.commandText ?? normalizedText.text);
    const bridgeText = isGroupCommand
      ? normalizedText.commandText ?? normalizedText.text
      : normalizedText.text;

    if (!isDm && !isGroupCommand && !isRegisteredGroupChat) {
      return;
    }

    this.dependencies.logger?.info?.(
      buildFeishuInboundLog({
        peerId,
        chatType: message.chat_type,
        messageId: message.message_id,
        chatId: message.chat_id,
        threadId: message.thread_id,
        text: bridgeText,
      }),
    );

    let cardController: StreamingCardControllerLike | undefined;
    let replies: BridgeReply[];
    try {
      replies = await this.dependencies.bridgeService.handleMessage(
        (isGroupCommand || isRegisteredGroupChat)
          ? {
              channel: "feishu",
              peerId,
              chatType: normalizedChatType,
              chatId: message.chat_id,
              text: bridgeText,
            }
          : {
              channel: "feishu",
              peerId,
              chatType: normalizedChatType,
              text: bridgeText,
            },
        {
          onProgress: async snapshot => {
            await this.tryDeliver("progress card", async () => {
              cardController ??= this.createStreamingCardController(
                peerId,
                message.chat_type === "group" ? message.message_id : undefined,
              );
              await cardController.push(sanitizeProgressSnapshotForFeishu(snapshot));
            });
          },
        },
      );
    } catch (error) {
      const errorText = formatFeishuCaErrorText(error);
      if (cardController) {
        await this.tryDeliver("error card", async () => {
          await cardController?.finalizeError(errorText);
        });
      }
      await this.tryDeliver("error text", async () => {
        await this.replyText({
          peerId,
          anchorMessageId: message.chat_type === "group" ? message.message_id : undefined,
          text: errorText,
        });
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

      if (reply.kind === "file") {
        await this.replyFile({
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
    const isRegisteredGroupChat = this.isRegisteredGroupMainline(message);
    if (!isDm && !isRegisteredGroupChat) {
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
      downloadDir: buildInboundAssetDownloadDir(
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

  private async handleInboundFile(input: {
    peerId: string;
    message: FeishuEnvelopeMessage;
  }): Promise<void> {
    const message = input.message;
    const fileContent = parseFeishuFileContent(message.content);
    if (!fileContent?.fileKey || !message.message_id) {
      return;
    }

    const isDm = message.chat_type === "p2p";
    const isRegisteredGroupChat = this.isRegisteredGroupMainline(message);
    if (!isDm && !isRegisteredGroupChat) {
      return;
    }

    const displayFileName = sanitizeInboundFileDisplayName(fileContent.fileName);
    this.dependencies.logger?.info?.(
      buildFeishuInboundLog({
        peerId: input.peerId,
        chatType: message.chat_type,
        messageId: message.message_id,
        chatId: message.chat_id,
        threadId: message.thread_id,
        text: displayFileName
          ? `[file:${fileContent.fileKey}:${displayFileName}]`
          : `[file:${fileContent.fileKey}]`,
      }),
    );

    const download = await this.requireDownloadClient().downloadMessageResource({
      messageId: message.message_id,
      fileKey: fileContent.fileKey,
      type: "file",
      downloadDir: buildInboundAssetDownloadDir(
        this.dependencies.inboundAssetRootDir,
        input.peerId,
        message,
      ),
      preferredFileName: fileContent.fileName ??
        `${sanitizePathSegment(message.message_id)}-${sanitizePathSegment(fileContent.fileKey)}.bin`,
    });

    this.requirePendingAssetStore().savePendingBridgeAsset({
      channel: "feishu",
      peerId: input.peerId,
      chatId: message.chat_id ?? null,
      surfaceType: message.thread_id ? "thread" : null,
      surfaceRef: message.thread_id ?? null,
      runId: null,
      messageId: message.message_id,
      resourceType: "file",
      resourceKey: fileContent.fileKey,
      localPath: download.localPath,
      fileName: download.fileName,
      mimeType: download.mimeType,
      fileSize: download.fileSize,
    });

    await this.replyText({
      peerId: input.peerId,
      anchorMessageId: message.chat_type === "group" ? message.message_id : undefined,
      text: buildInboundFileAckText(displayFileName),
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
    const delivery = resolveFeishuAssistantMessageDelivery(input.text);
    if (delivery.kind === "card") {
      await this.replyCard({
        peerId: input.peerId,
        anchorMessageId: input.anchorMessageId,
        card: delivery.card,
      });
      return;
    }

    await this.replyText({
      peerId: input.peerId,
      anchorMessageId: input.anchorMessageId,
      text: delivery.text,
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
    const imageSize = readLocalFileSize(input.reply.localPath);
    if (imageSize !== undefined && imageSize > FEISHU_FILE_UPLOAD_MAX_BYTES) {
      await this.replyText({
        peerId: input.peerId,
        anchorMessageId: input.anchorMessageId,
        text: formatOversizedImageFailureText(input.reply),
      });
      return;
    }

    const imageAsFileReply = maybeBuildOversizedImageFileReply(input.reply);
    if (imageAsFileReply) {
      await this.replyFile({
        peerId: input.peerId,
        anchorMessageId: input.anchorMessageId,
        reply: imageAsFileReply,
        successText: "图片超过原生图片限制，已作为文件发送。",
      });
      return;
    }

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

  private async replyFile(input: {
    peerId: string;
    anchorMessageId?: string;
    reply: Extract<BridgeReply, { kind: "file" }>;
    successText?: string;
  }): Promise<boolean> {
    const apiClient = this.dependencies.apiClient;
    const canSend = input.anchorMessageId
      ? !!apiClient.replyFileMessage
      : !!apiClient.sendFileMessage;
    if (!apiClient.uploadFile || !canSend) {
      await this.replyText({
        peerId: input.peerId,
        anchorMessageId: input.anchorMessageId,
        text: formatFileDeliveryFailureText(input.reply, new Error("FEISHU_FILE_REPLY_UNAVAILABLE")),
      });
      return false;
    }

    try {
      const fileKey = await apiClient.uploadFile({
        filePath: input.reply.localPath,
        fileName: input.reply.fileName,
        fileType: undefined,
        duration: undefined,
      });

      if (input.anchorMessageId) {
        await apiClient.replyFileMessage!(input.anchorMessageId, fileKey);
      } else {
        await apiClient.sendFileMessage!(input.peerId, fileKey);
      }

      if (input.successText) {
        await this.replyText({
          peerId: input.peerId,
          anchorMessageId: input.anchorMessageId,
          text: input.successText,
        });
      }
      return true;
    } catch (error) {
      this.dependencies.logger?.warn?.(
        `feishu file delivery failed: ${formatFeishuErrorText(error)}`,
      );
      await this.replyText({
        peerId: input.peerId,
        anchorMessageId: input.anchorMessageId,
        text: formatFileDeliveryFailureText(input.reply, error),
      });
      return false;
    }
  }

  private isRegisteredGroupMainline(message: FeishuEnvelopeMessage): boolean {
    return message.chat_type === "group" &&
      !!message.chat_id &&
      !message.thread_id &&
      (this.dependencies.isCodexGroupChat?.(message.chat_id) ?? false);
  }

  private async uploadImageKey(imagePath: string): Promise<string | undefined> {
    if (!this.dependencies.apiClient.uploadImage) {
      return undefined;
    }

    const result = await this.dependencies.apiClient.uploadImage({ imagePath });
    return extractImageKey(result);
  }

  private async tryDeliver(label: string, deliver: () => Promise<void>): Promise<void> {
    try {
      await deliver();
    } catch (error) {
      const message = `feishu delivery failed: ${label}: ${formatFeishuErrorText(error)}`;
      const logger = this.dependencies.logger;
      if (logger?.warn) {
        logger.warn(message);
        return;
      }
      logger?.info?.(message);
    }
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
      downloadMessageResource: this.dependencies.apiClient.downloadMessageResource.bind(this.dependencies.apiClient),
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

function formatFileDeliveryFailureText(
  reply: Extract<BridgeReply, { kind: "file" }>,
  error: unknown,
): string {
  const fileName = reply.fileName?.trim()
    ? formatLocalPathFileNameForUser(reply.fileName)
    : formatLocalPathFileNameForUser(reply.localPath);
  return `文件结果无法发送：${fileName}，${formatFileDeliveryFailureReason(error)}。`;
}

function formatFileDeliveryFailureReason(error: unknown): string {
  const message = error instanceof Error && error.message
    ? error.message
    : typeof error === "string"
      ? error
      : "";

  if (message.includes("FEISHU_FILE_UPLOAD_TOO_LARGE")) {
    return "文件超过 30 MB";
  }
  if (message.includes("FEISHU_FILE_UPLOAD_EMPTY")) {
    return "文件为空";
  }
  if (message.includes("FEISHU_FILE_UPLOAD_UNAVAILABLE") ||
      message.includes("FEISHU_FILE_REPLY_UNAVAILABLE")) {
    return "文件上传或发送能力不可用";
  }

  return "文件上传或发送失败";
}

function formatOversizedImageFailureText(
  reply: Extract<BridgeReply, { kind: "image" }>,
): string {
  return `图片结果无法发送：${formatLocalPathFileNameForUser(reply.localPath)} 超过 30 MB 文件上限。`;
}

function formatLocalPathFileNameForUser(localPath: string): string {
  const normalized = localPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? "图片文件";
}

const FEISHU_IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const FEISHU_FILE_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

function readLocalFileSize(localPath: string): number | undefined {
  try {
    return statSync(localPath).size;
  } catch {
    return undefined;
  }
}

function maybeBuildOversizedImageFileReply(
  reply: Extract<BridgeReply, { kind: "image" }>,
): Extract<BridgeReply, { kind: "file" }> | undefined {
  const size = readLocalFileSize(reply.localPath);
  if (size === undefined) {
    return undefined;
  }

  if (size <= FEISHU_IMAGE_UPLOAD_MAX_BYTES || size > FEISHU_FILE_UPLOAD_MAX_BYTES) {
    return undefined;
  }

  return {
    kind: "file",
    localPath: reply.localPath,
    fileName: path.basename(reply.localPath),
    caption: reply.caption,
    fileSize: size,
    semanticType: "generic",
  };
}

function sanitizeProgressSnapshotForFeishu(snapshot: ProgressCardState): ProgressCardState {
  if (snapshot.status !== "error") {
    return snapshot;
  }

  const prefix = "[ca] error: ";
  const errorText = snapshot.preview.startsWith(prefix)
    ? snapshot.preview.slice(prefix.length)
    : snapshot.preview;
  return {
    ...snapshot,
    preview: formatFeishuCaErrorText(errorText),
  };
}

function parseFeishuTextContent(content?: string): { text?: string; mentions: FeishuMention[] } {
  if (!content) {
    return {
      text: undefined,
      mentions: [],
    };
  }

  try {
    const parsed = JSON.parse(content) as { text?: string; mentions?: unknown[] };
    return {
      text: parsed.text?.trim() || undefined,
      mentions: parseFeishuMentions(parsed.mentions),
    };
  } catch {
    return {
      text: content.trim() || undefined,
      mentions: [],
    };
  }
}

function normalizeFeishuTextForRouting(input: {
  text?: string;
  chatType?: string;
  messageMentions?: FeishuMention[];
  contentMentions?: FeishuMention[];
  requireGroupMention: boolean;
}): { text?: string; commandText?: string; hasMention: boolean } {
  const text = input.text?.trim();
  if (!text) {
    return {
      text: undefined,
      commandText: undefined,
      hasMention: false,
    };
  }

  const mentions = mergeFeishuMentions(input.messageMentions, input.contentMentions);
  const hasMention = mentions.length > 0;
  if (input.chatType !== "group" || !hasMention) {
    return {
      text,
      commandText: text,
      hasMention,
    };
  }

  const allMentionKeys = mentions
    .map(mention => mention.key?.trim())
    .filter((key): key is string => Boolean(key));
  const botMentionKeys = mentions
    .filter(mention => mention.mentioned_type?.toLowerCase() === "bot")
    .map(mention => mention.key?.trim())
    .filter((key): key is string => Boolean(key));

  const commandText = stripLeadingMentionKeys(text, allMentionKeys);
  const normalizedText = botMentionKeys.length > 0
    ? stripLeadingMentionKeys(text, botMentionKeys)
    : input.requireGroupMention
      ? commandText
      : text;

  return {
    text: normalizedText.trim() || undefined,
    commandText: commandText.trim() || undefined,
    hasMention,
  };
}

function mergeFeishuMentions(
  messageMentions?: FeishuMention[],
  contentMentions?: FeishuMention[],
): FeishuMention[] {
  return [
    ...parseFeishuMentions(messageMentions),
    ...parseFeishuMentions(contentMentions),
  ];
}

function parseFeishuMentions(value?: unknown): FeishuMention[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const mentions: FeishuMention[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    const key = typeof candidate.key === "string" ? candidate.key.trim() : undefined;
    const mentionedType = typeof candidate.mentioned_type === "string"
      ? candidate.mentioned_type.trim()
      : undefined;
    if (!key) {
      continue;
    }

    mentions.push(mentionedType ? { key, mentioned_type: mentionedType } : { key });
  }

  return mentions;
}

function stripLeadingMentionKeys(text: string, mentionKeys: string[]): string {
  const uniqueKeys = [...new Set(mentionKeys.filter(key => key.length > 0))]
    .sort((left, right) => right.length - left.length);
  if (uniqueKeys.length === 0) {
    return text.trim();
  }

  let remaining = text.trimStart();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const key of uniqueKeys) {
      if (remaining.startsWith(key)) {
        remaining = remaining.slice(key.length).trimStart();
        stripped = true;
        break;
      }
    }
  }

  return remaining.trim();
}

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

function parseFeishuFileContent(content?: string): { fileKey: string; fileName?: string } | undefined {
  if (!content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const fileKey = typeof parsed.file_key === "string" ? parsed.file_key.trim() : "";
    if (!fileKey) {
      return undefined;
    }

    const fileName =
      typeof parsed.file_name === "string" && parsed.file_name.trim()
        ? parsed.file_name.trim()
        : typeof parsed.name === "string" && parsed.name.trim()
          ? parsed.name.trim()
          : undefined;

    return {
      fileKey,
      fileName,
    };
  } catch {
    return undefined;
  }
}

function buildInboundAssetDownloadDir(
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

function buildInboundFileAckText(fileName?: string): string {
  return fileName
    ? `已收到文件：${fileName}，请继续发送文字说明。`
    : "已收到文件，请继续发送文字说明。";
}

function sanitizeInboundFileDisplayName(fileName?: string): string | undefined {
  const normalized = fileName
    ?.replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\[ca\]\s*/i, "")
    .trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > MAX_INBOUND_FILE_DISPLAY_NAME_CHARS
    ? `${normalized.slice(0, MAX_INBOUND_FILE_DISPLAY_NAME_CHARS - 3)}...`
    : normalized;
}

const MAX_INBOUND_FILE_DISPLAY_NAME_CHARS = 120;
