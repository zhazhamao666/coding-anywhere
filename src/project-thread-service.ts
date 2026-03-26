import { randomUUID } from "node:crypto";

import type { CodexThreadRecord } from "./types.js";

interface ProjectThreadApiClientLike {
  sendTextMessageToChat(
    chatId: string,
    text: string,
  ): Promise<{ messageId: string; threadId: string }>;
}

interface ProjectThreadStoreLike {
  createCodexThread(input: CodexThreadRecord): void;
}

export class ProjectThreadService {
  public constructor(
    private readonly dependencies: {
      apiClient: ProjectThreadApiClientLike;
      store: ProjectThreadStoreLike;
    },
  ) {}

  public async createThread(input: {
    projectId: string;
    chatId: string;
    ownerOpenId: string;
    title: string;
  }): Promise<CodexThreadRecord> {
    const threadId = `thread-${randomUUID()}`;
    const rootMessage = buildThreadRootMessage(input.title);
    const created = await this.dependencies.apiClient.sendTextMessageToChat(input.chatId, rootMessage);

    const thread: CodexThreadRecord = {
      threadId,
      projectId: input.projectId,
      feishuThreadId: created.threadId,
      chatId: input.chatId,
      anchorMessageId: created.messageId,
      latestMessageId: created.messageId,
      sessionName: buildThreadSessionName(input.projectId, threadId),
      title: input.title,
      ownerOpenId: input.ownerOpenId,
      status: "provisioned",
    };

    this.dependencies.store.createCodexThread(thread);

    return thread;
  }
}

function buildThreadRootMessage(title: string): string {
  return `[thread] ${title}`;
}

function buildThreadSessionName(projectId: string, threadId: string): string {
  return `codex-${projectId}-${threadId}`;
}
