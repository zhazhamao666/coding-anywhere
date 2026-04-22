import { createHash } from "node:crypto";

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
} from "./types.js";

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
  sendInteractiveCard(peerId: string, card: Record<string, unknown>): Promise<string>;
  sendInteractiveCardToChat?(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<{ messageId: string; threadId: string }>;
  replyTextMessage(messageId: string, text: string): Promise<string>;
  replyInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<string>;
  updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void>;
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

    const resultText = resolveCompletionResultText(input.completion.finalAssistantText);
    const thread = this.dependencies.codexCatalog?.getThread(input.completion.threadId);
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
