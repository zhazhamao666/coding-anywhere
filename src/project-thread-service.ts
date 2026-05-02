import type { CodexThreadRecord } from "./types.js";

interface ProjectThreadApiClientLike {
  sendTextMessageToChat(
    chatId: string,
    text: string,
  ): Promise<{ messageId: string; threadId: string }>;
}

interface ProjectThreadRunnerLike {
  createThread(input: {
    cwd: string;
    prompt: string;
  }): Promise<{ threadId: string }>;
}

interface ProjectThreadStoreLike {
  createCodexThread(input: CodexThreadRecord): void;
}

export class ProjectThreadService {
  public constructor(
    private readonly dependencies: {
      apiClient: ProjectThreadApiClientLike;
      runner: ProjectThreadRunnerLike;
      store: ProjectThreadStoreLike;
    },
  ) {}

  public async createThread(input: {
    projectId: string;
    cwd: string;
    chatId: string;
    ownerOpenId: string;
    title: string;
  }): Promise<CodexThreadRecord> {
    const rootMessage = buildThreadRootMessage(input.title);
    const created = await this.dependencies.apiClient.sendTextMessageToChat(input.chatId, rootMessage);
    const createdThread = await this.dependencies.runner.createThread({
      cwd: input.cwd,
      prompt: buildNativeThreadBootstrapPrompt(input.title),
    });

    const thread: CodexThreadRecord = {
      threadId: createdThread.threadId,
      projectId: input.projectId,
      feishuThreadId: created.threadId,
      chatId: input.chatId,
      anchorMessageId: created.messageId,
      latestMessageId: created.messageId,
      sessionName: createdThread.threadId,
      title: input.title,
      ownerOpenId: input.ownerOpenId,
      status: "warm",
    };

    this.dependencies.store.createCodexThread(thread);

    return thread;
  }

  public async linkThread(input: {
    projectId: string;
    chatId: string;
    ownerOpenId: string;
    title: string;
    codexThreadId: string;
  }): Promise<CodexThreadRecord> {
    const rootMessage = buildThreadRootMessage(input.title);
    const created = await this.dependencies.apiClient.sendTextMessageToChat(input.chatId, rootMessage);

    const thread: CodexThreadRecord = {
      threadId: input.codexThreadId,
      projectId: input.projectId,
      feishuThreadId: created.threadId,
      chatId: input.chatId,
      anchorMessageId: created.messageId,
      latestMessageId: created.messageId,
      sessionName: input.codexThreadId,
      title: input.title,
      ownerOpenId: input.ownerOpenId,
      status: "warm",
    };

    this.dependencies.store.createCodexThread(thread);

    return thread;
  }
}

function buildThreadRootMessage(title: string): string {
  return `[thread] ${title}`;
}

function buildNativeThreadBootstrapPrompt(sessionLabel: string): string {
  return [
    "Initialize a Codex session for subsequent Feishu bridge messages.",
    "Keep the response minimal.",
    `Session: ${sessionLabel}`,
  ].join("\n");
}
