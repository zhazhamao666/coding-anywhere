import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexDesktopCompletionEvent } from "../src/codex-desktop-completion-observer.js";
import { DesktopCompletionNotifier } from "../src/desktop-completion-notifier.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("DesktopCompletionNotifier", () => {
  const harnesses: NotifierHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      harness?.store.close();
      if (harness) {
        rmSync(harness.rootDir, { recursive: true, force: true });
      }
    }
  });

  it("sends a DM notification card, follows with the full result, and advances the notified key", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "任务已经处理完成。",
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledWith(
      "ou_demo",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务已完成",
          }),
        }),
      }),
    );
    expect(harness.apiClient.sendTextMessage).toHaveBeenCalledWith(
      "ou_demo",
      "任务已经处理完成。",
    );
    expect(firstCallOrder(harness.apiClient.sendInteractiveCard)).toBeLessThan(
      firstCallOrder(harness.apiClient.sendTextMessage),
    );
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
  });

  it("replies card and full result into an existing Feishu topic via the stored thread anchor", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });
    seedThreadBinding(harness.store, {
      threadId: "thread-native-1",
      projectId: "project-key-1",
      chatId: "oc_group_1",
      feishuThreadId: "omt_topic_1",
      anchorMessageId: "om_anchor_topic_1",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "线程内结果已经就位。",
      }),
      target: {
        mode: "thread",
        chatId: "oc_group_1",
        surfaceRef: "omt_topic_1",
      },
    });

    expect(harness.apiClient.replyInteractiveCard).toHaveBeenCalledWith(
      "om_anchor_topic_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务已完成",
          }),
        }),
      }),
    );
    expect(harness.apiClient.replyTextMessage).toHaveBeenCalledWith(
      "om_anchor_topic_1",
      "线程内结果已经就位。",
    );
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
  });

  it("posts a project-group notification card to the timeline and replies with the full result under the new root", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "项目群里的完整结果也发好了。",
      }),
      target: {
        mode: "project_group",
        chatId: "oc_group_1",
      },
    });

    expect(harness.apiClient.sendInteractiveCardToChat).toHaveBeenCalledWith(
      "oc_group_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务已完成",
          }),
        }),
      }),
    );
    expect(harness.apiClient.replyTextMessage).toHaveBeenCalledWith(
      "om_group_root_card_1",
      "项目群里的完整结果也发好了。",
    );
    expect(firstCallOrder(harness.apiClient.sendInteractiveCardToChat)).toBeLessThan(
      firstCallOrder(harness.apiClient.replyTextMessage),
    );
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
  });

  it("does not advance the notified key when the full-result send fails after the notification card succeeds", async () => {
    const harness = createHarness(harnesses, {
      apiClientOverrides: {
        sendTextMessage: vi.fn(async () => {
          throw new Error("FEISHU_FULL_RESULT_SEND_FAILED");
        }),
      },
    });
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });

    await expect(harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "这条消息会发送失败。",
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    })).rejects.toThrow("FEISHU_FULL_RESULT_SEND_FAILED");

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });
  });

  it("reuses the standard assistant markdown-card delivery policy for the final result", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: [
          "**明确待办**",
          "- 收尾桌面完成通知",
          "- 保持 Feishu markdown 卡回退策略一致",
        ].join("\n"),
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(harness.apiClient.sendInteractiveCard).toHaveBeenNthCalledWith(
      2,
      "ou_demo",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "完整回复",
          }),
        }),
        config: expect.objectContaining({
          summary: expect.objectContaining({
            content: "明确待办",
          }),
        }),
        body: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              tag: "markdown",
              content: expect.stringContaining("**明确待办**"),
            }),
          ]),
        }),
      }),
    );
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
  });
});

interface NotifierHarness {
  rootDir: string;
  store: SessionStore;
  notifier: DesktopCompletionNotifier;
  apiClient: ReturnType<typeof createApiClientDouble>;
}

function createHarness(
  harnesses: NotifierHarness[],
  input?: {
    apiClientOverrides?: Partial<ReturnType<typeof createApiClientDouble>>;
  },
): NotifierHarness {
  const rootDir = mkdtempSync(path.join(tmpdir(), "desktop-completion-notifier-"));
  const store = new SessionStore(path.join(rootDir, "bridge.db"));
  const apiClient = createApiClientDouble(input?.apiClientOverrides);
  const codexCatalog = {
    getThread: vi.fn(() => ({
      threadId: "thread-native-1",
      projectKey: "project-key-1",
      cwd: "D:/repo-one",
      displayName: "Repo One",
      title: "修复桌面完成通知",
      source: "user",
      archived: false,
      updatedAt: "2026-04-20T10:00:00.000Z",
      createdAt: "2026-04-20T09:00:00.000Z",
      gitBranch: "main",
      cliVersion: "0.0.0",
      rolloutPath: "D:/repo-one/.codex/rollout.jsonl",
    })),
    listRecentConversation: vi.fn(() => [
      {
        role: "assistant" as const,
        text: "上一轮 assistant 回复",
        timestamp: "2026-04-20T10:00:00.000Z",
      },
      {
        role: "user" as const,
        text: "请把完整结果发回飞书，并给一个清晰的通知卡。",
        timestamp: "2026-04-20T09:59:00.000Z",
      },
    ]),
  };
  const notifier = new DesktopCompletionNotifier({
    apiClient: apiClient as any,
    store,
    codexCatalog: codexCatalog as any,
  });
  const harness = {
    rootDir,
    store,
    notifier,
    apiClient,
  };
  harnesses.push(harness);
  return harness;
}

function createApiClientDouble(
  overrides?: Partial<{
    sendTextMessage: ReturnType<typeof vi.fn>;
    sendInteractiveCard: ReturnType<typeof vi.fn>;
    sendInteractiveCardToChat: ReturnType<typeof vi.fn>;
    replyTextMessage: ReturnType<typeof vi.fn>;
    replyInteractiveCard: ReturnType<typeof vi.fn>;
  }>,
) {
  return {
    sendTextMessage: vi.fn(async () => "om_dm_text_1"),
    sendInteractiveCard: vi.fn(async () => "om_dm_card_1"),
    sendInteractiveCardToChat: vi.fn(async () => ({
      messageId: "om_group_root_card_1",
      threadId: "omt_group_root_1",
    })),
    replyTextMessage: vi.fn(async () => "om_reply_text_1"),
    replyInteractiveCard: vi.fn(async () => "om_reply_card_1"),
    ...overrides,
  };
}

function createCompletion(
  overrides?: Partial<CodexDesktopCompletionEvent>,
): CodexDesktopCompletionEvent {
  return {
    threadId: "thread-native-1",
    completedAt: "2026-04-20T12:00:00.000Z",
    finalAssistantText: "任务已经处理完成。",
    completionKey: "thread-native-1:completion-new",
    ...overrides,
  };
}

function seedWatchState(
  store: SessionStore,
  input: {
    threadId: string;
    lastNotifiedCompletionKey?: string | null;
  },
): void {
  store.upsertCodexThreadWatchState({
    threadId: input.threadId,
    rolloutPath: `D:/codex/${input.threadId}.jsonl`,
    rolloutMtime: "2026-04-20T11:59:00.000Z",
    lastReadOffset: 256,
    lastCompletionKey: "thread-native-1:completion-old",
    lastNotifiedCompletionKey: input.lastNotifiedCompletionKey ?? null,
  });
}

function seedThreadBinding(
  store: SessionStore,
  input: {
    threadId: string;
    projectId: string;
    chatId: string;
    feishuThreadId: string;
    anchorMessageId: string;
  },
): void {
  store.createProject({
    projectId: input.projectId,
    name: "Repo One",
    cwd: "D:/repo-one",
    repoRoot: "D:/repo-one",
    createdAt: "2026-04-20T09:00:00.000Z",
    updatedAt: "2026-04-20T09:00:00.000Z",
  });
  store.createCodexThread({
    threadId: input.threadId,
    projectId: input.projectId,
    feishuThreadId: input.feishuThreadId,
    chatId: input.chatId,
    anchorMessageId: input.anchorMessageId,
    latestMessageId: input.anchorMessageId,
    sessionName: input.threadId,
    title: "修复桌面完成通知",
    ownerOpenId: "ou_demo",
    status: "warm",
    createdAt: "2026-04-20T09:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    lastActivityAt: "2026-04-20T10:00:00.000Z",
    archivedAt: null,
    lastRunId: null,
  });
}

function firstCallOrder(mockFn: ReturnType<typeof vi.fn>): number {
  return mockFn.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
}
