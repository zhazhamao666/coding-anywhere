import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseBridgeAssetDirectives,
  validateBridgeAssetPath,
} from "./bridge-asset-directive.js";
import type {
  CodexDesktopCompletionEvent,
  CodexDesktopProgressSnapshot,
} from "./codex-desktop-completion-observer.js";
import { isSyntheticDesktopReminderText } from "./desktop-reminder-text.js";
import { buildDesktopCompletionCard } from "./feishu-card/desktop-completion-card-builder.js";
import { normalizeMarkdownToPlainText } from "./markdown-text.js";
import type {
  CodexCatalogConversationItem,
  CodexDesktopDisplaySnapshot,
  CodexCatalogThread,
  CodexThreadDesktopNotificationStateRecord,
  CodexThreadWatchStateRecord,
  BridgeReply,
} from "./types.js";
import type { FeishuBridgeFileType } from "./bridge-asset-directive.js";

const BODY_UNAVAILABLE_RESULT_TEXT = "完整正文暂不可用（body unavailable）。";

export type DesktopCompletionDeliveryTarget =
  | {
      mode: "dm";
      peerId: string;
    }
  | {
      mode: "thread";
      chatId: string;
      surfaceRef: string;
      anchorMessageId: string;
    }
  | {
      mode: "project_group";
      chatId: string;
    };

interface DesktopCompletionNotifierApiClientLike {
  sendTextMessage(peerId: string, text: string): Promise<string>;
  sendTextMessageToChat?(chatId: string, text: string): Promise<{ messageId: string; threadId: string }>;
  sendInteractiveCard(peerId: string, card: Record<string, unknown>): Promise<string>;
  sendInteractiveCardToChat?(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<{ messageId: string; threadId: string }>;
  replyTextMessage(messageId: string, text: string): Promise<string>;
  replyInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<string>;
  updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  uploadImage?(input: {
    imagePath: string;
    imageType?: "message" | "avatar";
  }): Promise<{ imageKey?: string; image_key?: string } | string>;
  sendImageMessage?(peerId: string, imageKey: string): Promise<string>;
  replyImageMessage?(messageId: string, imageKey: string): Promise<string>;
  sendImageMessageToChat?(chatId: string, imageKey: string): Promise<{ messageId: string; threadId: string }>;
  uploadFile?(input: {
    filePath: string;
    fileName?: string;
    fileType?: FeishuBridgeFileType;
    duration?: number;
  }): Promise<string>;
  sendFileMessage?(peerId: string, fileKey: string): Promise<string>;
  replyFileMessage?(messageId: string, fileKey: string): Promise<string>;
  sendFileMessageToChat?(chatId: string, fileKey: string): Promise<{ messageId: string; threadId: string }>;
}

interface DesktopCompletionNotifierStoreLike {
  getCodexThreadWatchState(threadId: string): CodexThreadWatchStateRecord | undefined;
  upsertCodexThreadWatchState(input: {
    threadId: string;
    lastNotifiedCompletionKey?: string | null;
  }): void;
  getCodexThreadDesktopNotificationState(threadId: string): CodexThreadDesktopNotificationStateRecord | undefined;
  upsertCodexThreadDesktopNotificationState(input: {
    threadId: string;
    activeRunKey?: string | null;
    status?: CodexThreadDesktopNotificationStateRecord["status"];
    startedAt?: string | null;
    lastEventAt?: string | null;
    messageId?: string | null;
    deliveryMode?: CodexThreadDesktopNotificationStateRecord["deliveryMode"];
    peerId?: string | null;
    chatId?: string | null;
    surfaceType?: CodexThreadDesktopNotificationStateRecord["surfaceType"];
    surfaceRef?: string | null;
    anchorMessageId?: string | null;
    latestPublicMessage?: string | null;
    planTodos?: CodexThreadDesktopNotificationStateRecord["planTodos"];
    commandCount?: number;
    lastRenderHash?: string | null;
    lastCompletionKey?: string | null;
  }): void;
}

interface DesktopCompletionNotifierCodexCatalogLike {
  getThread(threadId: string): CodexCatalogThread | undefined;
  listRecentConversation(threadId: string, limit?: number): CodexCatalogConversationItem[];
  getDesktopDisplaySnapshot?(threadId: string): CodexDesktopDisplaySnapshot | undefined;
}

export class DesktopCompletionNotifier {
  public constructor(
    private readonly dependencies: {
      apiClient: DesktopCompletionNotifierApiClientLike;
      store: DesktopCompletionNotifierStoreLike;
      codexCatalog?: DesktopCompletionNotifierCodexCatalogLike;
    },
  ) {}

  public async publish(input: {
    completion: CodexDesktopCompletionEvent;
    target: DesktopCompletionDeliveryTarget;
  }): Promise<void> {
    await this.publishCompletion(input);
  }

  public async publishRunning(input: {
    threadId: string;
    progress: CodexDesktopProgressSnapshot;
    target: DesktopCompletionDeliveryTarget;
  }): Promise<void> {
    this.assertWatchStateExists(input.threadId);

    const thread = this.dependencies.codexCatalog?.getThread(input.threadId);
    const reminderText = resolveLastHumanUserText(
      this.dependencies.codexCatalog,
      input.threadId,
      thread?.title,
    );
    const card = buildDesktopCompletionCard({
      ...buildCardRouteContext(input.target),
      status: "running",
      projectName: resolveProjectName(thread, input.threadId),
      threadTitle: resolveThreadTitle(thread, input.threadId),
      startedAt: input.progress.startedAt,
      reminderText,
      progressText: input.progress.latestPublicMessage,
      planTodos: input.progress.planTodos ?? undefined,
      threadId: input.threadId,
    });
    const messageId = await this.sendNotification(input.target, card);

    this.dependencies.store.upsertCodexThreadDesktopNotificationState({
      threadId: input.threadId,
      activeRunKey: input.progress.runKey,
      status: "running_notified",
      startedAt: input.progress.startedAt,
      lastEventAt: input.progress.lastEventAt,
      messageId,
      deliveryMode: input.target.mode,
      peerId: input.target.mode === "dm" ? input.target.peerId : null,
      chatId: input.target.mode !== "dm" ? input.target.chatId : null,
      surfaceType: input.target.mode === "thread" ? "thread" : null,
      surfaceRef: input.target.mode === "thread" ? input.target.surfaceRef : null,
      anchorMessageId: input.target.mode === "thread" ? input.target.anchorMessageId : null,
      latestPublicMessage: input.progress.latestPublicMessage ?? null,
      planTodos: input.progress.planTodos ?? null,
      commandCount: input.progress.commandCount,
      lastRenderHash: buildDesktopNotificationRenderHash({
        status: "running",
        progress: input.progress,
        reminderText,
      }),
    });
  }

  public async updateRunning(input: {
    threadId: string;
    progress: CodexDesktopProgressSnapshot;
  }): Promise<void> {
    this.assertWatchStateExists(input.threadId);
    const notificationState = this.dependencies.store.getCodexThreadDesktopNotificationState(input.threadId);
    if (!notificationState?.messageId) {
      throw new Error("FEISHU_DESKTOP_NOTIFICATION_STATE_NOT_FOUND");
    }

    const thread = this.dependencies.codexCatalog?.getThread(input.threadId);
    const reminderText = resolveLastHumanUserText(
      this.dependencies.codexCatalog,
      input.threadId,
      thread?.title,
    );
    const card = buildDesktopCompletionCard({
      ...buildCardRouteContext(resolveFrozenTarget(notificationState)),
      status: "running",
      projectName: resolveProjectName(thread, input.threadId),
      threadTitle: resolveThreadTitle(thread, input.threadId),
      startedAt: input.progress.startedAt,
      reminderText,
      progressText: input.progress.latestPublicMessage,
      planTodos: input.progress.planTodos ?? undefined,
      threadId: input.threadId,
    });

    await this.dependencies.apiClient.updateInteractiveCard(notificationState.messageId, card);

    this.dependencies.store.upsertCodexThreadDesktopNotificationState({
      threadId: input.threadId,
      activeRunKey: input.progress.runKey,
      status: "running_notified",
      startedAt: input.progress.startedAt,
      lastEventAt: input.progress.lastEventAt,
      latestPublicMessage: input.progress.latestPublicMessage ?? null,
      planTodos: input.progress.planTodos ?? null,
      commandCount: input.progress.commandCount,
      lastRenderHash: buildDesktopNotificationRenderHash({
        status: "running",
        progress: input.progress,
        reminderText,
      }),
    });
  }

  public async publishCompletion(input: {
    completion: CodexDesktopCompletionEvent;
    target?: DesktopCompletionDeliveryTarget;
    progress?: CodexDesktopProgressSnapshot;
  }): Promise<void> {
    this.assertWatchStateExists(input.completion.threadId);

    const thread = this.dependencies.codexCatalog?.getThread(input.completion.threadId);
    const completionAssets = buildCompletionBridgeAssetReplies({
      finalAssistantText: input.completion.finalAssistantText,
      cwd: thread?.cwd,
      outputRootDir: buildDesktopCompletionOutputRootDir(input.completion.threadId, input.completion.completionKey),
    });
    const resultText = resolveCompletionResultText(completionAssets.cleanedText);
    const reminderText = resolveLastHumanUserText(
      this.dependencies.codexCatalog,
      input.completion.threadId,
      thread?.title,
    );
    const existingState = this.dependencies.store.getCodexThreadDesktopNotificationState(input.completion.threadId);
    const patchableState = existingState?.status === "running_notified" ? existingState : undefined;
    const target = patchableState ? resolveFrozenTarget(patchableState) : input.target;
    if (!target) {
      throw new Error("FEISHU_DESKTOP_COMPLETION_TARGET_REQUIRED");
    }

    const card = buildDesktopCompletionCard({
      ...buildCardRouteContext(target),
      status: "completed",
      projectName: resolveProjectName(thread, input.completion.threadId),
      threadTitle: resolveThreadTitle(thread, input.completion.threadId),
      completedAt: input.completion.completedAt,
      resultText,
      reminderText,
      threadId: input.completion.threadId,
    });

    let messageId = patchableState?.messageId ?? null;
    if (patchableState?.messageId) {
      try {
        await this.dependencies.apiClient.updateInteractiveCard(patchableState.messageId, card);
      } catch {
        messageId = await this.sendNotification(target, card);
      }
    } else {
      messageId = await this.sendNotification(target, card);
    }

    this.dependencies.store.upsertCodexThreadWatchState({
      threadId: input.completion.threadId,
      lastNotifiedCompletionKey: input.completion.completionKey,
    });
    this.dependencies.store.upsertCodexThreadDesktopNotificationState({
      threadId: input.completion.threadId,
      activeRunKey: input.progress?.runKey ?? patchableState?.activeRunKey ?? null,
      status: "completed",
      startedAt: input.progress?.startedAt ?? patchableState?.startedAt ?? null,
      lastEventAt: input.completion.completedAt,
      messageId,
      deliveryMode: target.mode,
      peerId: target.mode === "dm" ? target.peerId : null,
      chatId: target.mode !== "dm" ? target.chatId : null,
      surfaceType: target.mode === "thread" ? "thread" : null,
      surfaceRef: target.mode === "thread" ? target.surfaceRef : null,
      anchorMessageId: target.mode === "thread" ? target.anchorMessageId : null,
      latestPublicMessage: input.progress?.latestPublicMessage ?? patchableState?.latestPublicMessage ?? null,
      planTodos: input.progress?.planTodos ?? patchableState?.planTodos ?? null,
      commandCount: input.progress?.commandCount ?? patchableState?.commandCount ?? 0,
      lastRenderHash: buildDesktopNotificationRenderHash({
        status: "completed",
        completion: input.completion,
        reminderText,
      }),
      lastCompletionKey: input.completion.completionKey,
    });

    await this.deliverCompletionBridgeAssets({
      target,
      replies: completionAssets.replies,
      visibleTexts: completionAssets.visibleTexts,
    });
  }

  private async sendNotification(
    target: DesktopCompletionDeliveryTarget,
    card: Record<string, unknown>,
  ): Promise<string> {
    switch (target.mode) {
      case "dm":
        return this.dependencies.apiClient.sendInteractiveCard(target.peerId, card);
      case "project_group": {
        if (!this.dependencies.apiClient.sendInteractiveCardToChat) {
          throw new Error("FEISHU_GROUP_INTERACTIVE_CARD_SEND_UNAVAILABLE");
        }
        const created = await this.dependencies.apiClient.sendInteractiveCardToChat(target.chatId, card);
        return created.messageId;
      }
      case "thread":
        return this.dependencies.apiClient.replyInteractiveCard(target.anchorMessageId, card);
    }
  }

  private assertWatchStateExists(threadId: string): void {
    if (!this.dependencies.store.getCodexThreadWatchState(threadId)) {
      throw new Error("FEISHU_DESKTOP_WATCH_STATE_NOT_FOUND");
    }
  }

  private async deliverCompletionBridgeAssets(input: {
    target: DesktopCompletionDeliveryTarget;
    replies: CompletionBridgeAssetReply[];
    visibleTexts: string[];
  }): Promise<void> {
    const visibleTexts = [...input.visibleTexts];

    for (const reply of input.replies) {
      try {
        const deliveredVisibleText = reply.kind === "image"
          ? await this.deliverCompletionImage(input.target, reply)
          : await this.deliverCompletionFile(input.target, reply);
        if (deliveredVisibleText) {
          visibleTexts.push(deliveredVisibleText);
        }
      } catch (error) {
        visibleTexts.push(formatResourceDeliveryFailureText(reply, error));
      }
    }

    if (visibleTexts.length === 0) {
      return;
    }

    await this.deliverVisibleText(input.target, visibleTexts.join("\n"));
  }

  private async deliverCompletionImage(
    target: DesktopCompletionDeliveryTarget,
    reply: Extract<CompletionBridgeAssetReply, { kind: "image" }>,
  ): Promise<string | undefined> {
    const imageSize = readLocalFileSize(reply.localPath);
    if (imageSize !== undefined && imageSize > FEISHU_FILE_UPLOAD_MAX_BYTES) {
      return formatOversizedImageFailureText(reply);
    }

    if (imageSize !== undefined && imageSize > FEISHU_IMAGE_UPLOAD_MAX_BYTES) {
      await this.deliverCompletionFile(target, {
        kind: "file",
        localPath: reply.localPath,
        fileName: path.basename(reply.localPath),
        caption: reply.caption,
        fileSize: imageSize,
        semanticType: "generic",
      });
      return "图片超过原生图片限制，已作为文件发送。";
    }

    const apiClient = this.dependencies.apiClient;
    if (!apiClient.uploadImage) {
      throw new Error("FEISHU_IMAGE_REPLY_UNAVAILABLE");
    }

    const imageKey = extractImageKey(await apiClient.uploadImage({
      imagePath: reply.localPath,
    }));
    if (!imageKey) {
      throw new Error("FEISHU_IMAGE_REPLY_UNAVAILABLE");
    }

    switch (target.mode) {
      case "dm":
        if (apiClient.sendImageMessage) {
          await apiClient.sendImageMessage(target.peerId, imageKey);
          return undefined;
        }
        break;
      case "thread":
        if (apiClient.replyImageMessage) {
          await apiClient.replyImageMessage(target.anchorMessageId, imageKey);
          return undefined;
        }
        break;
      case "project_group":
        if (apiClient.sendImageMessageToChat) {
          await apiClient.sendImageMessageToChat(target.chatId, imageKey);
          return undefined;
        }
        break;
    }

    throw new Error("FEISHU_IMAGE_REPLY_UNAVAILABLE");
  }

  private async deliverCompletionFile(
    target: DesktopCompletionDeliveryTarget,
    reply: Extract<CompletionBridgeAssetReply, { kind: "file" }>,
  ): Promise<undefined> {
    const fileSize = reply.fileSize ?? readLocalFileSize(reply.localPath);
    if (fileSize !== undefined && fileSize > FEISHU_FILE_UPLOAD_MAX_BYTES) {
      throw new Error("FEISHU_FILE_UPLOAD_TOO_LARGE");
    }

    const apiClient = this.dependencies.apiClient;
    if (!apiClient.uploadFile) {
      throw new Error("FEISHU_FILE_REPLY_UNAVAILABLE");
    }

    const fileKey = await apiClient.uploadFile({
      filePath: reply.localPath,
      fileName: reply.fileName,
      fileType: undefined,
      duration: undefined,
    });
    if (!fileKey) {
      throw new Error("FEISHU_FILE_REPLY_UNAVAILABLE");
    }

    switch (target.mode) {
      case "dm":
        if (apiClient.sendFileMessage) {
          await apiClient.sendFileMessage(target.peerId, fileKey);
          return undefined;
        }
        break;
      case "thread":
        if (apiClient.replyFileMessage) {
          await apiClient.replyFileMessage(target.anchorMessageId, fileKey);
          return undefined;
        }
        break;
      case "project_group":
        if (apiClient.sendFileMessageToChat) {
          await apiClient.sendFileMessageToChat(target.chatId, fileKey);
          return undefined;
        }
        break;
    }

    throw new Error("FEISHU_FILE_REPLY_UNAVAILABLE");
  }

  private async deliverVisibleText(
    target: DesktopCompletionDeliveryTarget,
    text: string,
  ): Promise<void> {
    try {
      switch (target.mode) {
        case "dm":
          await this.dependencies.apiClient.sendTextMessage(target.peerId, text);
          return;
        case "thread":
          await this.dependencies.apiClient.replyTextMessage(target.anchorMessageId, text);
          return;
        case "project_group":
          await this.dependencies.apiClient.sendTextMessageToChat?.(target.chatId, text);
          return;
      }
    } catch {
      return;
    }
  }
}

type CompletionBridgeAssetReply = Extract<BridgeReply, { kind: "image" | "file" }>;

function buildCompletionBridgeAssetReplies(input: {
  finalAssistantText: string;
  cwd?: string;
  outputRootDir: string;
}): {
  cleanedText: string;
  replies: CompletionBridgeAssetReply[];
  visibleTexts: string[];
} {
  const parsed = parseBridgeAssetDirectives(
    input.finalAssistantText,
    input.cwd ? { cwd: input.cwd } : undefined,
  );
  const replies: CompletionBridgeAssetReply[] = [];
  const visibleTexts = [...parsed.errors];
  const cwd = input.cwd?.trim();

  for (const asset of parsed.assets) {
    if (!cwd) {
      visibleTexts.push(`[ca] asset unavailable: desktop thread cwd unavailable ${formatPathFileNameForUser(asset.path)}`);
      continue;
    }

    const validation = validateBridgeAssetPath({
      kind: asset.kind,
      candidatePath: asset.path,
      cwd,
      allowedRootDirs: [input.outputRootDir],
      fileName: asset.fileName,
      caption: asset.caption,
      presentation: asset.presentation,
      preview: asset.preview,
    });
    if (!validation.ok) {
      visibleTexts.push(asset.kind === "image"
        ? validation.errorText.replace("[ca] asset unavailable:", "[ca] image unavailable:")
        : validation.errorText);
      continue;
    }

    if (validation.asset.kind === "image") {
      replies.push({
        kind: "image",
        localPath: validation.asset.localPath,
        caption: validation.asset.caption,
      });
      continue;
    }

    replies.push({
      kind: "file",
      localPath: validation.asset.localPath,
      fileName: validation.asset.fileName,
      caption: validation.asset.caption,
      mimeType: validation.asset.mimeType,
      fileSize: validation.asset.fileSize,
      semanticType: validation.asset.semanticType,
      presentation: validation.asset.presentation,
      preview: validation.asset.preview,
    });
  }

  return {
    cleanedText: parsed.cleanedText,
    replies,
    visibleTexts,
  };
}

function buildDesktopCompletionOutputRootDir(threadId: string, completionKey: string): string {
  return path.join(
    tmpdir(),
    "coding-anywhere",
    "desktop-completion-outbound",
    sanitizePathSegment(threadId),
    sanitizePathSegment(completionKey),
  );
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "asset";
}

export function buildDesktopNotificationRenderHash(input: {
  status: "running" | "completed";
  progress?: CodexDesktopProgressSnapshot;
  completion?: CodexDesktopCompletionEvent;
  reminderText?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      status: input.status,
      runKey: input.progress?.runKey ?? null,
      startedAt: input.progress?.startedAt ?? null,
      lastEventAt: input.progress?.lastEventAt ?? null,
      latestPublicMessage: input.progress?.latestPublicMessage ?? null,
      ...(input.status === "running"
        ? {
            planTodos: input.progress?.planTodos ?? null,
          }
        : {}),
      completionKey: input.completion?.completionKey ?? null,
      reminderText: input.reminderText ?? null,
    }))
    .digest("hex");
}

function resolveProjectName(
  thread: CodexCatalogThread | undefined,
  threadId: string,
): string {
  return thread?.displayName?.trim() || thread?.projectKey?.trim() || threadId;
}

function resolveThreadTitle(
  thread: CodexCatalogThread | undefined,
  threadId: string,
): string {
  return thread?.title?.trim() || threadId;
}

function resolveLastHumanUserText(
  codexCatalog: DesktopCompletionNotifierCodexCatalogLike | undefined,
  threadId: string,
  threadTitleFallback?: string,
): string | undefined {
  const snapshot = codexCatalog?.getDesktopDisplaySnapshot?.(threadId);
  const snapshotText = snapshot?.lastHumanUserText ?? "";
  const structuredText = normalizeMarkdownToPlainText(snapshot?.lastHumanUserText ?? "").trim();
  if (structuredText && !isSyntheticDesktopReminderText(snapshotText)) {
    return structuredText;
  }

  return resolveLastUserReminder(
    codexCatalog?.listRecentConversation(threadId, 8) ?? [],
    threadTitleFallback,
  );
}

function resolveLastUserReminder(
  conversation: CodexCatalogConversationItem[],
  threadTitleFallback?: string,
): string | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const item = conversation[index];
    if (item.role !== "user") {
      continue;
    }

    if (isSyntheticDesktopReminderText(item.text)) {
      continue;
    }

    const normalized = normalizeMarkdownToPlainText(item.text).trim();
    if (normalized) {
      return normalized;
    }
  }

  const normalizedFallback = normalizeMarkdownToPlainText(threadTitleFallback ?? "").trim();
  return normalizedFallback || undefined;
}

function resolveCompletionResultText(finalAssistantText: string): string {
  return finalAssistantText.trim() ? finalAssistantText : BODY_UNAVAILABLE_RESULT_TEXT;
}

function extractImageKey(value: { imageKey?: string; image_key?: string } | string): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  return value.imageKey?.trim() || value.image_key?.trim() || undefined;
}

function readLocalFileSize(localPath: string): number | undefined {
  try {
    return statSync(localPath).size;
  } catch {
    return undefined;
  }
}

function formatOversizedImageFailureText(
  reply: Extract<CompletionBridgeAssetReply, { kind: "image" }>,
): string {
  return `图片结果无法发送：${formatPathFileNameForUser(reply.localPath)} 超过 30 MB 文件上限。`;
}

function formatResourceDeliveryFailureText(
  reply: CompletionBridgeAssetReply,
  error: unknown,
): string {
  const label = reply.kind === "image" ? "图片" : "文件";
  return `${label} ${getResourceReplyFileName(reply)} 投递失败：${formatResourceDeliveryErrorReason(error, reply.kind)}。`;
}

function formatResourceDeliveryErrorReason(error: unknown, kind: "image" | "file"): string {
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
  if (message.includes("FEISHU_FILE_UPLOAD_UNAVAILABLE")) {
    return "文件上传能力不可用";
  }
  if (message.includes("FEISHU_FILE_REPLY_UNAVAILABLE")) {
    return "文件上传或发送能力不可用";
  }
  if (message.includes("FEISHU_IMAGE_REPLY_UNAVAILABLE")) {
    return "图片上传或发送能力不可用";
  }

  return kind === "image" ? "图片上传或发送失败" : "文件上传或发送失败";
}

function getResourceReplyFileName(reply: CompletionBridgeAssetReply): string {
  if (reply.kind === "file" && reply.fileName?.trim()) {
    return formatPathFileNameForUser(reply.fileName);
  }
  return formatPathFileNameForUser(reply.localPath);
}

function formatPathFileNameForUser(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? "资源";
}

const FEISHU_IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const FEISHU_FILE_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

function buildCardRouteContext(target: DesktopCompletionDeliveryTarget): Pick<
  DesktopCompletionCardInputLike,
  "mode" | "chatId" | "surfaceType" | "surfaceRef"
> {
  switch (target.mode) {
    case "dm":
      return {
        mode: "dm",
      };
    case "project_group":
      return {
        mode: "project_group",
        chatId: target.chatId,
      };
    case "thread":
      return {
        mode: "thread",
        chatId: target.chatId,
        surfaceType: "thread",
        surfaceRef: target.surfaceRef,
      };
  }
}

type DesktopCompletionCardInputLike = {
  mode: "dm" | "project_group" | "thread";
  chatId?: string;
  surfaceType?: "thread";
  surfaceRef?: string;
};

function resolveFrozenTarget(
  state: CodexThreadDesktopNotificationStateRecord,
): DesktopCompletionDeliveryTarget {
  switch (state.deliveryMode) {
    case "dm":
      if (!state.peerId) {
        throw new Error("FEISHU_DESKTOP_DM_TARGET_PEER_REQUIRED");
      }
      return {
        mode: "dm",
        peerId: state.peerId,
      };
    case "project_group":
      if (!state.chatId) {
        throw new Error("FEISHU_DESKTOP_GROUP_TARGET_CHAT_REQUIRED");
      }
      return {
        mode: "project_group",
        chatId: state.chatId,
      };
    case "thread":
      if (!state.chatId || !state.surfaceRef || !state.anchorMessageId) {
        throw new Error("FEISHU_DESKTOP_THREAD_TARGET_CONTEXT_REQUIRED");
      }
      return {
        mode: "thread",
        chatId: state.chatId,
        surfaceRef: state.surfaceRef,
        anchorMessageId: state.anchorMessageId,
      };
    default:
      throw new Error("FEISHU_DESKTOP_NOTIFICATION_STATE_NOT_FOUND");
  }
}
