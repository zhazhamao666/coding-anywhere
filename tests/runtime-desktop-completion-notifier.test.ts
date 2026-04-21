import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import type {
  CodexCatalogConversationItem,
  CodexCatalogProject,
  CodexCatalogThread,
} from "../src/types.js";

describe("runtime desktop completion notifier", () => {
  const harnesses: RuntimeHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      if (!harness) {
        continue;
      }

      try {
        await harness.runtime.stop();
      } catch {
        // The runtime may fail before the server fully starts in red-phase tests.
      }
      rmSync(harness.rootDir, { recursive: true, force: true });
    }
  });

  it("bootstraps watch state, skips historical completions, and publishes only newly completed desktop turns", async () => {
    const harness = await createHarness(harnesses);

    expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toBeUndefined();

    await harness.runtime.start();

    await vi.waitFor(() => {
      expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toBeDefined();
    });
    expect(harness.apiClient.sendInteractiveCard).not.toHaveBeenCalled();
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();

    appendCompletion(
      harness.rolloutPath,
      "2026-04-21T09:10:00.000Z",
      "2026-04-21T09:10:01.000Z",
      "fresh completion one",
    );

    await vi.waitFor(() => {
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledTimes(1);
    });
    expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastCompletionKey: expect.stringContaining("thread-native-1:2026-04-21T09:10:01.000Z:"),
      lastNotifiedCompletionKey: expect.stringContaining(
        "thread-native-1:2026-04-21T09:10:01.000Z:",
      ),
    });

    await new Promise(resolve => setTimeout(resolve, 80));
    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(harness.apiClient.sendTextMessage).toHaveBeenCalledTimes(1);

    appendCompletion(
      harness.rolloutPath,
      "2026-04-21T09:12:00.000Z",
      "2026-04-21T09:12:01.000Z",
      "fresh completion two",
    );

    await vi.waitFor(() => {
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(2);
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledTimes(2);
    });
    expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastCompletionKey: expect.stringContaining("thread-native-1:2026-04-21T09:12:01.000Z:"),
      lastNotifiedCompletionKey: expect.stringContaining(
        "thread-native-1:2026-04-21T09:12:01.000Z:",
      ),
    });
  });
});

interface RuntimeHarness {
  rootDir: string;
  rolloutPath: string;
  runtime: Awaited<ReturnType<typeof createRuntime>>;
  apiClient: ReturnType<typeof createApiClientDouble>;
}

async function createHarness(harnesses: RuntimeHarness[]): Promise<RuntimeHarness> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-desktop-completion-"));
  const rolloutPath = path.join(rootDir, "thread-native-1.jsonl");
  writeFileSync(
    rolloutPath,
    [
      buildSessionMetaLine("thread-native-1"),
      buildFinalAnswerLine("2026-04-21T09:00:00.000Z", "historical completion"),
      buildTaskCompleteLine("2026-04-21T09:00:01.000Z"),
    ].join("\n") + "\n",
    "utf8",
  );

  const apiClient = createApiClientDouble();
  const codexCatalog = createCatalogDouble(rolloutPath);
  const runtime = await createRuntime(buildConfig(rootDir), {
    createApiClient: () => apiClient,
    createWsClient: () => ({
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }),
    createCodexCatalog: () => codexCatalog,
    desktopCompletionPollIntervalMs: 20,
  });

  const harness: RuntimeHarness = {
    rootDir,
    rolloutPath,
    runtime,
    apiClient,
  };
  harnesses.push(harness);
  return harness;
}

function buildConfig(rootDir: string): BridgeConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    storage: {
      sqlitePath: path.join(rootDir, "bridge.db"),
      logDir: path.join(rootDir, "logs"),
    },
    codex: {
      command: "codex",
      modelOptions: [],
      reasoningEffortOptions: [],
      speedOptions: [],
    },
    scheduler: {
      maxConcurrentRuns: 2,
    },
    feishu: {
      appId: "cli_xxx",
      appSecret: "secret",
      websocketUrl: "wss://example.invalid/ws",
      apiBaseUrl: "https://open.feishu.cn/open-apis",
      allowlist: ["ou_demo"],
      requireGroupMention: false,
      encryptKey: "",
      reconnectCount: -1,
      reconnectIntervalSeconds: 120,
      reconnectNonceSeconds: 30,
    },
    root: {
      id: "main",
      name: "Main Root",
      cwd: "D:/repos",
      repoRoot: "D:/repos",
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    },
  };
}

function createCatalogDouble(rolloutPath: string): {
  listProjects: () => CodexCatalogProject[];
  getProject: (projectKey: string) => CodexCatalogProject | undefined;
  listThreads: (projectKey: string) => CodexCatalogThread[];
  getThread: (threadId: string) => CodexCatalogThread | undefined;
  listRecentConversation: (threadId: string, limit?: number) => CodexCatalogConversationItem[];
} {
  const thread: CodexCatalogThread = {
    threadId: "thread-native-1",
    projectKey: "project-key-1",
    cwd: "D:/repo-one",
    displayName: "Repo One",
    title: "Desktop Thread",
    source: "desktop",
    archived: false,
    updatedAt: "2026-04-21T09:00:01.000Z",
    createdAt: "2026-04-21T08:50:00.000Z",
    gitBranch: "main",
    cliVersion: "0.0.0",
    rolloutPath,
  };
  const project: CodexCatalogProject = {
    projectKey: "project-key-1",
    cwd: "D:/repo-one",
    displayName: "Repo One",
    threadCount: 1,
    activeThreadCount: 1,
    lastUpdatedAt: "2026-04-21T09:00:01.000Z",
    gitBranch: "main",
  };

  return {
    listProjects: () => [project],
    getProject: projectKey => projectKey === project.projectKey ? project : undefined,
    listThreads: projectKey => projectKey === project.projectKey ? [thread] : [],
    getThread: threadId => threadId === thread.threadId ? thread : undefined,
    listRecentConversation: () => [{
      role: "user",
      text: "请在我离开电脑时告诉我结果。",
      timestamp: "2026-04-21T08:59:00.000Z",
    }],
  };
}

function createApiClientDouble() {
  return {
    sendTextMessage: vi.fn(async () => "msg-dm-text"),
    sendTextMessageToChat: vi.fn(async () => ({ messageId: "msg-chat-text", threadId: "omt-chat" })),
    replyTextMessage: vi.fn(async () => "msg-reply-text"),
    updateTextMessage: vi.fn(async () => undefined),
    sendInteractiveCard: vi.fn(async () => "msg-dm-card"),
    sendInteractiveCardToChat: vi.fn(async () => ({
      messageId: "msg-chat-card",
      threadId: "omt-chat-card",
    })),
    replyInteractiveCard: vi.fn(async () => "msg-reply-card"),
    updateInteractiveCard: vi.fn(async () => undefined),
    createCardEntity: vi.fn(async () => "card-1"),
    sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
    streamCardElement: vi.fn(async () => undefined),
    setCardStreamingMode: vi.fn(async () => undefined),
    updateCardKitCard: vi.fn(async () => undefined),
  };
}

function appendCompletion(
  rolloutPath: string,
  finalAnswerTimestamp: string,
  completedAt: string,
  text: string,
): void {
  appendFileSync(
    rolloutPath,
    `${buildFinalAnswerLine(finalAnswerTimestamp, text)}\n${buildTaskCompleteLine(completedAt)}\n`,
    "utf8",
  );
}

function buildSessionMetaLine(threadId: string): string {
  return JSON.stringify({
    timestamp: "2026-04-21T08:50:00.000Z",
    type: "session_meta",
    payload: {
      id: threadId,
      timestamp: "2026-04-21T08:50:00.000Z",
      cwd: "D:\\Repos\\Demo",
      cli_version: "0.116.0",
      source: "desktop",
    },
  });
}

function buildFinalAnswerLine(timestamp: string, text: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [
        {
          type: "output_text",
          text,
        },
      ],
    },
  });
}

function buildTaskCompleteLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "task_complete",
    },
  });
}
