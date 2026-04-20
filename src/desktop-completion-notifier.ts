import type { CodexDesktopCompletionEvent } from "./codex-desktop-completion-observer.js";
import { resolveFeishuAssistantMessageDelivery } from "./feishu-assistant-message.js";
import { buildDesktopCompletionCard } from "./feishu-card/desktop-completion-card-builder.js";
import { normalizeMarkdownToPlainText } from "./markdown-text.js";
import type {
  CodexCatalogConversationItem,
  CodexCatalogThread,
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
  sendInteractiveCardToChat(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<{ messageId: string; threadId: string }>;
  replyTextMessage(messageId: string, text: string): Promise<string>;
  replyInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<string>;
}

interface DesktopCompletionNotifierStoreLike {
  getCodexThreadWatchState(threadId: string): CodexThreadWatchStateRecord | undefined;
  upsertCodexThreadWatchState(input: {
    threadId: string;
    lastNotifiedCompletionKey?: string | null;
  }): void;
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
    this.assertWatchStateExists(input.completion.threadId);

    const resultText = resolveCompletionResultText(input.completion.finalAssistantText);
    const thread = this.dependencies.codexCatalog?.getThread(input.completion.threadId);
    const card = buildDesktopCompletionCard({
      mode: input.target.mode,
      projectName: resolveProjectName(thread, input.completion),
      threadTitle: resolveThreadTitle(thread, input.completion),
      completedAt: input.completion.completedAt,
      summaryLines: buildSummaryLines(resultText),
      reminderText: resolveLastUserReminder(
        this.dependencies.codexCatalog?.listRecentConversation(input.completion.threadId, 8) ?? [],
      ),
      threadId: input.completion.threadId,
    });

    const delivery = resolveFeishuAssistantMessageDelivery(resultText);
    const notificationAnchor = await this.sendNotification(input.target, card);

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
        await this.dependencies.apiClient.replyInteractiveCard(target.anchorMessageId, card);
        return target.anchorMessageId;
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

  private assertWatchStateExists(threadId: string): void {
    if (!this.dependencies.store.getCodexThreadWatchState(threadId)) {
      throw new Error("FEISHU_DESKTOP_WATCH_STATE_NOT_FOUND");
    }
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

function resolveLastUserReminder(conversation: CodexCatalogConversationItem[]): string | undefined {
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
  const normalized = normalizeMarkdownToPlainText(finalAssistantText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (normalized.length > 0) {
    return normalized;
  }

  return [BODY_UNAVAILABLE_RESULT_TEXT];
}

function resolveCompletionResultText(finalAssistantText: string): string {
  return finalAssistantText.trim() ? finalAssistantText : BODY_UNAVAILABLE_RESULT_TEXT;
}
