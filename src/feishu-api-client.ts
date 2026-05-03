import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Client } from "@larksuiteoapi/node-sdk";

import { mapBridgeAssetToFeishuFileType } from "./bridge-asset-directive.js";
import { buildFeishuOutboundLog } from "./feishu-message-log.js";
import type { FeishuBridgeFileType } from "./bridge-asset-directive.js";
import type { BridgeAssetDownloadResult } from "./types.js";

interface SdkResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

interface FeishuSdkClientLike {
  im: {
    message: {
      create(params: Record<string, unknown>): Promise<{
        data?: {
          message_id?: string;
          thread_id?: string;
        };
      }>;
      reply(params: Record<string, unknown>): Promise<{
        data?: {
          message_id?: string;
          thread_id?: string;
        };
      }>;
      patch(params: Record<string, unknown>): Promise<unknown>;
      update(params: Record<string, unknown>): Promise<unknown>;
    };
    v1?: {
      image?: {
        create(params: Record<string, unknown>): Promise<{
          image_key?: string;
        } | null>;
      };
      file?: {
        create(params: Record<string, unknown>): Promise<{
          file_key?: string;
        } | null>;
      };
      messageResource?: {
        get(params: Record<string, unknown>): Promise<{
          writeFile(filePath: string): Promise<unknown>;
          headers: unknown;
        }>;
      };
    };
  };
  request?: (params: Record<string, unknown>) => Promise<SdkResponse>;
  cardkit: {
    v1: {
      card: {
        create(params: Record<string, unknown>): Promise<SdkResponse>;
        settings(params: Record<string, unknown>): Promise<SdkResponse>;
        update(params: Record<string, unknown>): Promise<SdkResponse>;
      };
      cardElement: {
        content(params: Record<string, unknown>): Promise<SdkResponse>;
      };
    };
  };
}

export class FeishuApiClient {
  private readonly sdkClient: FeishuSdkClientLike;
  private readonly logger?: {
    info?: (message: string) => void;
  };
  private readonly now: () => number;
  private readonly pushLogWindowMs: number;
  private readonly recentOutboundLogs = new Map<string, number>();
  private static readonly fileUploadMaxBytes = 30 * 1024 * 1024;

  public constructor(
    private readonly config: {
      appId: string;
      appSecret: string;
      apiBaseUrl: string;
    },
    sdkClient?: FeishuSdkClientLike,
    options?: {
      logger?: {
        info?: (message: string) => void;
      };
      now?: () => number;
      pushLogWindowMs?: number;
    },
  ) {
    this.sdkClient = sdkClient ?? new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: normalizeSdkDomain(this.config.apiBaseUrl),
    }) as unknown as FeishuSdkClientLike;
    this.logger = options?.logger;
    this.now = options?.now ?? (() => Date.now());
    this.pushLogWindowMs = options?.pushLogWindowMs ?? 60_000;
  }

  public async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
    downloadDir: string;
    preferredFileName?: string;
  }): Promise<BridgeAssetDownloadResult> {
    const messageResourceClient = this.sdkClient.im.v1?.messageResource;
    if (!messageResourceClient) {
      throw new Error("FEISHU_MESSAGE_RESOURCE_UNAVAILABLE");
    }

    mkdirSync(input.downloadDir, { recursive: true });
    const response = await messageResourceClient.get({
      params: {
        type: input.type,
      },
      path: {
        message_id: input.messageId,
        file_key: input.fileKey,
      },
    });

    const headers = normalizeHeaderMap(response.headers);
    const fileName = resolveDownloadedFileName(
      headers,
      input.preferredFileName ?? `${input.fileKey}.bin`,
    );
    const localPath = path.join(input.downloadDir, fileName);
    await response.writeFile(localPath);

    const fileStat = statSync(localPath);
    return {
      resourceKey: input.fileKey,
      localPath,
      fileName,
      mimeType: headers["content-type"] ?? null,
      fileSize: fileStat.size,
    };
  }

  public async uploadImage(input: {
    imagePath: string;
    imageType?: "message" | "avatar";
  }): Promise<string> {
    const imageClient = this.sdkClient.im.v1?.image;
    if (!imageClient) {
      throw new Error("FEISHU_IMAGE_UPLOAD_UNAVAILABLE");
    }

    const response = await imageClient.create({
      data: {
        image_type: input.imageType ?? "message",
        image: readFileSync(input.imagePath),
      },
    });
    const imageKey = response?.image_key ?? "";
    if (!imageKey) {
      throw new Error("FEISHU_IMAGE_UPLOAD_FAILED");
    }

    this.logOutbound(
      {
        messageType: "image",
        mode: "upload",
        imageKey,
      },
      [`image:${imageKey}`],
    );
    return imageKey;
  }

  public async uploadFile(input: {
    filePath: string;
    fileName?: string;
    fileType?: FeishuBridgeFileType;
    duration?: number;
  }): Promise<string> {
    const fileClient = this.sdkClient.im.v1?.file;
    if (!fileClient) {
      throw new Error("FEISHU_FILE_UPLOAD_UNAVAILABLE");
    }

    const fileStat = statSync(input.filePath);
    if (fileStat.size === 0) {
      throw new Error("FEISHU_FILE_UPLOAD_EMPTY");
    }
    if (fileStat.size > FeishuApiClient.fileUploadMaxBytes) {
      throw new Error("FEISHU_FILE_UPLOAD_TOO_LARGE");
    }

    const fileName = sanitizeFileName(input.fileName ?? path.basename(input.filePath));
    const data: Record<string, unknown> = {
      file_type: input.fileType ?? mapBridgeAssetToFeishuFileType({
        localPath: input.filePath,
        fileName,
      }),
      file_name: fileName,
      file: readFileSync(input.filePath),
    };
    if (input.duration !== undefined) {
      data.duration = input.duration;
    }

    const response = await fileClient.create({
      data,
    });
    const fileKey = response?.file_key ?? "";
    if (!fileKey) {
      throw new Error("FEISHU_FILE_UPLOAD_FAILED");
    }

    this.logOutbound(
      {
        messageType: "file",
        mode: "upload",
        fileKey,
      },
      [`file:${fileKey}`],
    );
    return fileKey;
  }

  public async sendTextMessage(peerId: string, text: string): Promise<string> {
    const response = await this.sdkClient.im.message.create({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: peerId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    const messageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "text",
        mode: "create",
        messageId,
        peerId,
        text,
      },
      [`message:${messageId}`],
    );
    return messageId;
  }

  public async sendTextMessageToChat(
    chatId: string,
    text: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const response = await this.sdkClient.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    const messageId = response.data?.message_id ?? "";
    const threadId = response.data?.thread_id ?? "";
    this.logOutbound(
      {
        messageType: "text",
        mode: "create",
        messageId,
        chatId,
        threadId,
        text,
      },
      [`message:${messageId}`],
    );
    return {
      messageId,
      threadId,
    };
  }

  public async updateTextMessage(messageId: string, text: string): Promise<void> {
    await this.sdkClient.im.message.update({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    this.logOutbound(
      {
        messageType: "text",
        mode: "patch",
        messageId,
        text,
      },
      [`message:${messageId}`],
      true,
    );
  }

  public async replyTextMessage(messageId: string, text: string): Promise<string> {
    const response = await this.sdkClient.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    const replyMessageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "text",
        mode: "reply",
        messageId: replyMessageId,
        anchorMessageId: messageId,
        threadId: response.data?.thread_id ?? "",
        text,
      },
      [`message:${replyMessageId}`],
    );
    return replyMessageId;
  }

  public async sendImageMessage(peerId: string, imageKey: string): Promise<string> {
    const response = await this.sdkClient.im.message.create({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: peerId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });

    const messageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "image",
        mode: "create",
        messageId,
        peerId,
        imageKey,
      },
      [`message:${messageId}`, `image:${imageKey}`],
    );
    return messageId;
  }

  public async replyImageMessage(messageId: string, imageKey: string): Promise<string> {
    const response = await this.sdkClient.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });

    const replyMessageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "image",
        mode: "reply",
        messageId: replyMessageId,
        anchorMessageId: messageId,
        threadId: response.data?.thread_id ?? "",
        imageKey,
      },
      [`message:${replyMessageId}`, `image:${imageKey}`],
    );
    return replyMessageId;
  }

  public async sendFileMessage(peerId: string, fileKey: string): Promise<string> {
    const response = await this.sdkClient.im.message.create({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: peerId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    const messageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "file",
        mode: "create",
        messageId,
        peerId,
        fileKey,
      },
      [`message:${messageId}`, `file:${fileKey}`],
    );
    return messageId;
  }

  public async replyFileMessage(messageId: string, fileKey: string): Promise<string> {
    const response = await this.sdkClient.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    const replyMessageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "file",
        mode: "reply",
        messageId: replyMessageId,
        anchorMessageId: messageId,
        threadId: response.data?.thread_id ?? "",
        fileKey,
      },
      [`message:${replyMessageId}`, `file:${fileKey}`],
    );
    return replyMessageId;
  }

  public async sendInteractiveCard(peerId: string, card: Record<string, unknown>): Promise<string> {
    const response = await this.sdkClient.im.message.create({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: peerId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    const messageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "create",
        messageId,
        peerId,
        card,
      },
      [`message:${messageId}`],
    );
    return messageId;
  }

  public async sendInteractiveCardToChat(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<{ messageId: string; threadId: string }> {
    const response = await this.sdkClient.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    const messageId = response.data?.message_id ?? "";
    const threadId = response.data?.thread_id ?? "";
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "create",
        messageId,
        chatId,
        threadId,
        card,
      },
      [`message:${messageId}`],
    );
    return {
      messageId,
      threadId,
    };
  }

  public async updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.sdkClient.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "patch",
        messageId,
        card,
      },
      [`message:${messageId}`],
      true,
    );
  }

  public async delayUpdateInteractiveCard(input: {
    token: string;
    card: Record<string, unknown>;
  }): Promise<void> {
    if (!this.sdkClient.request) {
      throw new Error("FEISHU_DELAY_UPDATE_UNAVAILABLE");
    }

    const response = await this.sdkClient.request({
      method: "POST",
      url: `${normalizeSdkDomain(this.config.apiBaseUrl)}/open-apis/interactive/v1/card/update`,
      data: {
        token: input.token,
        card: input.card,
      },
    });
    assertSdkSuccess(response, "interactive.card.update");
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "delay_patch",
        card: input.card,
      },
      [`interaction-token:${input.token}`],
      true,
    );
  }

  public async replyInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<string> {
    const response = await this.sdkClient.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    const replyMessageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "reply",
        messageId: replyMessageId,
        anchorMessageId: messageId,
        threadId: response.data?.thread_id ?? "",
        card,
      },
      [`message:${replyMessageId}`],
    );
    return replyMessageId;
  }

  public async createCardEntity(card: Record<string, unknown>): Promise<string> {
    const response = await this.sdkClient.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(card),
      },
    });
    assertSdkSuccess(response, "cardkit.create");

    return ((response.data?.card_id ?? (response as Record<string, unknown>).card_id) as string | undefined) ?? "";
  }

  public async sendCardKitMessage(peerId: string, cardId: string): Promise<string> {
    const response = await this.sdkClient.im.message.create({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: peerId,
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: cardId,
          },
        }),
      },
    });

    const messageId = response.data?.message_id ?? "";
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "cardkit",
        messageId,
        peerId,
        cardId,
      },
      [`message:${messageId}`, `card:${cardId}`],
    );
    return messageId;
  }

  public async streamCardElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    const response = await this.sdkClient.cardkit.v1.cardElement.content({
      path: {
        card_id: cardId,
        element_id: elementId,
      },
      data: {
        content,
        sequence,
      },
    });
    assertSdkSuccess(response, "cardkit.element.content");
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "cardkit",
        cardId,
      },
      [`card:${cardId}`],
      true,
    );
  }

  public async setCardStreamingMode(
    cardId: string,
    streamingMode: boolean,
    sequence: number,
  ): Promise<void> {
    const response = await this.sdkClient.cardkit.v1.card.settings({
      path: {
        card_id: cardId,
      },
      data: {
        settings: JSON.stringify({
          streaming_mode: streamingMode,
        }),
        sequence,
      },
    });
    assertSdkSuccess(response, "cardkit.settings");
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "cardkit",
        cardId,
      },
      [`card:${cardId}`],
      true,
    );
  }

  public async updateCardKitCard(
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    const response = await this.sdkClient.cardkit.v1.card.update({
      path: {
        card_id: cardId,
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify(card),
        },
        sequence,
      },
    });
    assertSdkSuccess(response, "cardkit.update");
    this.logOutbound(
      {
        messageType: "interactive",
        mode: "cardkit",
        cardId,
        card,
      },
      [`card:${cardId}`],
      true,
    );
  }

  private logOutbound(
    input: {
      mode: string;
      messageType: "text" | "interactive" | "image" | "file";
      messageId?: string;
      peerId?: string;
      chatId?: string;
      threadId?: string;
      anchorMessageId?: string;
      cardId?: string;
      imageKey?: string;
      fileKey?: string;
      text?: string;
      card?: Record<string, unknown>;
    },
    keys: string[],
    suppressIfRecent = false,
  ): void {
    if (!this.logger?.info) {
      return;
    }

    const effectiveKeys = keys.filter(Boolean);
    const now = this.now();
    this.pruneRecentOutboundLogs(now);

    if (
      suppressIfRecent &&
      effectiveKeys.some(key => {
        const lastLoggedAt = this.recentOutboundLogs.get(key);
        return lastLoggedAt !== undefined && now - lastLoggedAt < this.pushLogWindowMs;
      })
    ) {
      return;
    }

    for (const key of effectiveKeys) {
      this.recentOutboundLogs.set(key, now);
    }

    this.logger.info(buildFeishuOutboundLog(input));
  }

  private pruneRecentOutboundLogs(now: number): void {
    for (const [key, lastLoggedAt] of this.recentOutboundLogs.entries()) {
      if (now - lastLoggedAt >= this.pushLogWindowMs) {
        this.recentOutboundLogs.delete(key);
      }
    }
  }
}

function assertSdkSuccess(response: SdkResponse, operation: string): void {
  if (response.code && response.code !== 0) {
    throw new Error(`${operation} failed: ${response.msg ?? response.code}`);
  }
}

function normalizeSdkDomain(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/open-apis\/?$/, "");
}

function normalizeHeaderMap(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter((entry): entry is [string, string | string[]] =>
        typeof entry[1] === "string" || Array.isArray(entry[1]),
      )
      .map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value[0] ?? "" : value,
      ]),
  );
}

function resolveDownloadedFileName(
  headers: Record<string, string>,
  fallbackFileName: string,
): string {
  const contentDisposition = headers["content-disposition"];
  const encodedMatch = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    const decodedFileName = tryDecodeURIComponent(encodedMatch[1]);
    if (decodedFileName) {
      return sanitizeFileName(decodedFileName);
    }
  }

  const plainMatch = contentDisposition?.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) {
    return sanitizeFileName(plainMatch[1]);
  }

  return sanitizeFileName(fallbackFileName);
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName).trim();
  const sanitized = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  if (!sanitized || /^[.\s]+$/.test(sanitized) || isWindowsReservedDeviceFileName(sanitized)) {
    return "download.bin";
  }

  return sanitized;
}

function tryDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isWindowsReservedDeviceFileName(fileName: string): boolean {
  const deviceName = fileName.split(".")[0]?.trim().toUpperCase();
  return deviceName === "CON" ||
    deviceName === "PRN" ||
    deviceName === "AUX" ||
    deviceName === "NUL" ||
    /^COM[1-9]$/.test(deviceName ?? "") ||
    /^LPT[1-9]$/.test(deviceName ?? "");
}
