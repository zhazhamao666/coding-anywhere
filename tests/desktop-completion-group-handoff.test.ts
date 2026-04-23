import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import { ProjectThreadService } from "../src/project-thread-service.js";
import type { CodexCatalogConversationItem, RunnerEvent } from "../src/types.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("desktop completion group/topic handoff", () => {
  const harnesses: DesktopCompletionGroupHandoffHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      harness?.store.close();
      if (harness) {
        rmSync(harness.rootDir, { recursive: true, force: true });
      }
    }
  });

  it("keeps an existing Feishu topic on the same surface and returns the standard session card", async () => {
    const harness = createHarness(harnesses);
    seedExistingTopicBinding(harness.store);

    const response = await harness.cardActionService.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_desktop_notify_topic_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "continue_desktop_thread",
          mode: "thread",
          threadId: "thread-alpha-2",
          chatId: "oc_chat_alpha",
          surfaceType: "thread",
          surfaceRef: "omt_existing_topic_alpha",
        },
      },
    });

    expect(harness.apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    const cardText = JSON.stringify(response);
    expect(cardText).toContain("当前会话已就绪");
    expect(cardText).toContain("Alpha follow-up");
    expect(cardText).toContain("最近上下文");
    expect(cardText).toContain("直接发送下一条消息继续当前线程");
    expect(cardText).toContain("下次任务设置");
    expect(cardText).not.toContain("命令已提交");
  });

  it("binds the current group chat directly to the native thread and returns the standard session card", async () => {
    const harness = createHarness(harnesses);

    const response = await harness.cardActionService.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_desktop_notify_group_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "continue_desktop_thread",
          mode: "project_group",
          threadId: "thread-alpha-2",
          chatId: "oc_chat_alpha",
        },
      },
    });

    expect(harness.apiClient.sendTextMessageToChat).not.toHaveBeenCalled();
    expect(harness.apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    expect(harness.store.getCodexChatBinding("feishu", "oc_chat_alpha")).toMatchObject({
      channel: "feishu",
      chatId: "oc_chat_alpha",
      codexThreadId: "thread-alpha-2",
    });
    const cardText = JSON.stringify(response);
    expect(cardText).toContain("当前会话已就绪");
    expect(cardText).toContain("Alpha follow-up");
    expect(cardText).toContain("最近上下文");
    expect(cardText).toContain("直接发送下一条消息继续当前线程");
    expect(cardText).toContain("下次任务设置");
    expect(cardText).not.toContain("新的飞书话题");
    expect(cardText).not.toContain("已在飞书继续");
    expect(cardText).not.toContain("命令已提交");
  });
});

interface DesktopCompletionGroupHandoffHarness {
  rootDir: string;
  store: SessionStore;
  apiClient: ReturnType<typeof createApiClientDouble>;
  bridge: BridgeService;
  cardActionService: FeishuCardActionService;
}

function createHarness(
  harnesses: DesktopCompletionGroupHandoffHarness[],
): DesktopCompletionGroupHandoffHarness {
  const rootDir = mkdtempSync(path.join(tmpdir(), "desktop-completion-group-handoff-"));
  const store = new SessionStore(path.join(rootDir, "bridge.db"));
  store.upsertRoot({
    id: "main",
    name: "Main Root",
    cwd: "D:\\Repos",
    repoRoot: "D:\\Repos",
    branchPolicy: "reuse",
    permissionMode: "workspace-write",
    envAllowlist: ["PATH"],
    idleTtlHours: 24,
  });
  store.createProject({
    projectId: "project-alpha",
    name: "Alpha",
    cwd: "D:\\Repos\\Alpha",
    repoRoot: "D:\\Repos\\Alpha",
  });
  store.upsertProjectChat({
    projectId: "project-alpha",
    chatId: "oc_chat_alpha",
    groupMessageType: "thread",
    title: "Alpha Group",
  });

  const apiClient = createApiClientDouble();
  const projectThreadService = new ProjectThreadService({
    apiClient: apiClient as any,
    runner: createRunnerDouble() as any,
    store,
  });
  const bridge = new BridgeService({
    store,
    runner: createRunnerDouble(),
    projectThreadService,
    codexCatalog: createCatalogDouble() as any,
  });
  const cardActionService = new FeishuCardActionService({
    bridgeService: bridge as any,
    apiClient: apiClient as any,
  });

  const harness = {
    rootDir,
    store,
    apiClient,
    bridge,
    cardActionService,
  };
  harnesses.push(harness);
  return harness;
}

function seedExistingTopicBinding(store: SessionStore): void {
  store.createCodexThread({
    threadId: "thread-alpha-2",
    projectId: "project-alpha",
    chatId: "oc_chat_alpha",
    feishuThreadId: "omt_existing_topic_alpha",
    anchorMessageId: "om_existing_topic_alpha",
    latestMessageId: "om_existing_topic_alpha",
    sessionName: "thread-alpha-2",
    title: "Alpha follow-up",
    ownerOpenId: "ou_demo",
    status: "warm",
  });
}

function createApiClientDouble() {
  return {
    sendTextMessage: vi.fn(async () => "msg-text-1"),
    sendTextMessageToChat: vi.fn(async () => ({
      messageId: "om_linked_topic_alpha",
      threadId: "omt_linked_topic_alpha",
    })),
    replyTextMessage: vi.fn(async () => "msg-reply-text-1"),
    updateTextMessage: vi.fn(async () => undefined),
    sendInteractiveCard: vi.fn(async () => "msg-card-1"),
    replyInteractiveCard: vi.fn(async () => "msg-reply-card-1"),
    updateInteractiveCard: vi.fn(async () => undefined),
    createCardEntity: vi.fn(async () => "card-1"),
    sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
    streamCardElement: vi.fn(async () => undefined),
    setCardStreamingMode: vi.fn(async () => undefined),
    updateCardKitCard: vi.fn(async () => undefined),
  };
}

function createRunnerDouble(
  events: RunnerEvent[] = [
    { type: "text", content: "桌面线程已继续处理" },
    { type: "done", content: "桌面线程已继续处理" },
  ],
) {
  return {
    createThread: vi.fn(async () => ({
      exitCode: 0,
      events: [],
      threadId: "thread-created",
    })),
    ensureSession: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    submitVerbatim: vi.fn(async (
      _context,
      _prompt,
      optionsOrOnEvent?: { images?: string[] } | ((event: RunnerEvent) => void),
      maybeOnEvent?: (event: RunnerEvent) => void,
    ) => {
      const onEvent = typeof optionsOrOnEvent === "function"
        ? optionsOrOnEvent
        : maybeOnEvent;

      for (const event of events) {
        onEvent?.(event);
      }

      return {
        exitCode: 0,
        events,
      };
    }),
  };
}

function createCatalogDouble() {
  const project = {
    projectKey: "project-alpha",
    cwd: "D:\\Repos\\Alpha",
    displayName: "Alpha",
    threadCount: 2,
    activeThreadCount: 2,
    lastUpdatedAt: "2026-04-20T10:00:00.000Z",
    gitBranch: "main",
  };
  const thread = {
    threadId: "thread-alpha-2",
    projectKey: "project-alpha",
    cwd: "D:\\Repos\\Alpha",
    displayName: "Alpha",
    title: "Alpha follow-up",
    source: "vscode",
    archived: false,
    updatedAt: "2026-04-20T10:30:00.000Z",
    createdAt: "2026-04-20T09:00:00.000Z",
    gitBranch: "main",
    cliVersion: "0.0.0",
    rolloutPath: "D:/Repos/Alpha/.codex/rollout.jsonl",
  };
  const recentConversation: CodexCatalogConversationItem[] = [
    {
      role: "user",
      text: "桌面上次的请求是补齐完成通知继续链路。",
      timestamp: "2026-04-20T10:05:00.000Z",
    },
    {
      role: "assistant",
      text: "已经在桌面端完成通知发送，接下来要把飞书继续入口接上。",
      timestamp: "2026-04-20T10:10:00.000Z",
    },
  ];

  return {
    listProjects: vi.fn(() => [project]),
    getProject: vi.fn((projectKey: string) => projectKey === project.projectKey ? project : undefined),
    listThreads: vi.fn((projectKey: string) => projectKey === project.projectKey ? [thread] : []),
    getThread: vi.fn((threadId: string) => threadId === thread.threadId ? thread : undefined),
    listRecentConversation: vi.fn((threadId: string) => threadId === thread.threadId ? recentConversation : []),
  };
}
