import type { CodexDesktopCompletionEvent } from "./codex-desktop-completion-observer.js";
import { resolveFeishuAssistantMessageDelivery } from "./feishu-assistant-message.js";
import { buildDesktopCompletionCard } from "./feishu-card/desktop-completion-card-builder.js";
import { normalizeMarkdownToPlainText } from "./markdown-text.js";
import type { CodexCatalogConversationItem, CodexCatalogThread, CodexThreadRecord } from "./types.js";

export type DesktopCompletionDeliveryTarget =
  | {
      mode: "dm";
      peerId: string;
    }
  | {
      mode: "thread";
      chatId: string;
      surfaceRef: string;
    }
  | {
      mode: "project_group";
      chatId: string;
    };

interface DesktopCompletionNotifierApiClientLike {
  sendTextMessage(peerId: string, text: string): Promise<string>;
  sendInteractiveCard(peerId: string, card: Record<string, unknown>): Promise<string>;
  sendInteractiveCardToChat(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<{ messageId: string; threadId: string }>;
  replyTextMessage(messageId: string, text: string): Promise<string>;
  replyInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<string>;
}

interface DesktopCompletionNotifierStoreLike {
  upsertCodexThreadWatchState(input: {
    threadId: string;
    lastNotifiedCompletionKey?: string | null;
  }): void;
  getPreferredCodexThreadBinding(threadId: string): CodexThreadRecord | undefined;
}

interface DesktopCompletionNotifierCodexCatalogLike {
  getThread(threadId: string): CodexCatalogThread | undefined;
  listRecentConversation(threadId: string, limit?: number): CodexCatalogConversationItem[];
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
    const thread = this.dependencies.codexCatalog?.getThread(input.completion.threadId);
    const card = buildDesktopCompletionCard({
      mode: input.target.mode === "dm" ? "dm" : "project_group",
      projectName: resolveProjectName(thread, input.completion),
      threadTitle: resolveThreadTitle(thread, input.completion),
      completedAt: input.completion.completedAt,
      summaryLines: buildSummaryLines(input.completion.finalAssistantText),
      lastUserHint: resolveLastUserHint(
        this.dependencies.codexCatalog?.listRecentConversation(input.completion.threadId, 8) ?? [],
      ),
      threadId: input.completion.threadId,
    });

    const delivery = resolveFeishuAssistantMessageDelivery(input.completion.finalAssistantText);
    const notificationAnchor = await this.sendNotification(input.target, input.completion.threadId, card);

    if (delivery.kind === "card") {
      await this.sendCardResult(input.target, notificationAnchor, delivery.card);
    } else {
      await this.sendTextResult(input.target, notificationAnchor, delivery.text);
    }

    this.dependencies.store.upsertCodexThreadWatchState({
      threadId: input.completion.threadId,
      lastNotifiedCompletionKey: input.completion.completionKey,
    });
  }

  private async sendNotification(
    target: DesktopCompletionDeliveryTarget,
    threadId: string,
    card: Record<string, unknown>,
  ): Promise<string | undefined> {
    switch (target.mode) {
      case "dm":
        await this.dependencies.apiClient.sendInteractiveCard(target.peerId, card);
        return undefined;
      case "project_group": {
        const created = await this.dependencies.apiClient.sendInteractiveCardToChat(target.chatId, card);
        return created.messageId;
      }
      case "thread": {
        const anchorMessageId = this.resolveThreadAnchorMessageId(threadId, target);
        await this.dependencies.apiClient.replyInteractiveCard(anchorMessageId, card);
        return anchorMessageId;
      }
    }
  }

  private async sendCardResult(
    target: DesktopCompletionDeliveryTarget,
    anchorMessageId: string | undefined,
    card: Record<string, unknown>,
  ): Promise<void> {
    switch (target.mode) {
      case "dm":
        await this.dependencies.apiClient.sendInteractiveCard(target.peerId, card);
        return;
      case "project_group":
      case "thread":
        if (!anchorMessageId) {
          throw new Error("FEISHU_DESKTOP_RESULT_ANCHOR_REQUIRED");
        }
        await this.dependencies.apiClient.replyInteractiveCard(anchorMessageId, card);
    }
  }

  private async sendTextResult(
    target: DesktopCompletionDeliveryTarget,
    anchorMessageId: string | undefined,
    text: string,
  ): Promise<void> {
    switch (target.mode) {
      case "dm":
        await this.dependencies.apiClient.sendTextMessage(target.peerId, text);
        return;
      case "project_group":
      case "thread":
        if (!anchorMessageId) {
          throw new Error("FEISHU_DESKTOP_RESULT_ANCHOR_REQUIRED");
        }
        await this.dependencies.apiClient.replyTextMessage(anchorMessageId, text);
    }
  }

  private resolveThreadAnchorMessageId(
    threadId: string,
    target: Extract<DesktopCompletionDeliveryTarget, { mode: "thread" }>,
  ): string {
    const binding = this.dependencies.store.getPreferredCodexThreadBinding(threadId);
    if (
      !binding?.anchorMessageId ||
      binding.chatId !== target.chatId ||
      binding.feishuThreadId !== target.surfaceRef
    ) {
      throw new Error("FEISHU_DESKTOP_THREAD_ANCHOR_NOT_FOUND");
    }

    return binding.anchorMessageId;
  }
}

function resolveProjectName(
  thread: CodexCatalogThread | undefined,
  completion: CodexDesktopCompletionEvent,
): string {
  return thread?.displayName?.trim() || thread?.projectKey?.trim() || completion.threadId;
}

function resolveThreadTitle(
  thread: CodexCatalogThread | undefined,
  completion: CodexDesktopCompletionEvent,
): string {
  return thread?.title?.trim() || completion.threadId;
}

function resolveLastUserHint(conversation: CodexCatalogConversationItem[]): string | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const item = conversation[index];
    if (item.role !== "user") {
      continue;
    }

    const normalized = normalizeMarkdownToPlainText(item.text).trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function buildSummaryLines(finalAssistantText: string): string[] {
  return normalizeMarkdownToPlainText(finalAssistantText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3);
}
