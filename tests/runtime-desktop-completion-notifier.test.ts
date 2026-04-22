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

  it("creates one running card, patches it on progress updates, and then patches the same card into completion", async () => {
    const harness = await createHarness(harnesses);

    await harness.runtime.start();
    await vi.waitFor(() => {
      expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toBeDefined();
    });

    appendRunningProgress(harness.rolloutPath, {
      startedAt: "2026-04-21T09:05:00.000Z",
      turnId: "turn-1",
      commentaryAt: "2026-04-21T09:05:01.000Z",
      commentary: "Task 1 已 review 完，我现在补测试和文档。",
      planAt: "2026-04-21T09:05:02.000Z",
      plan: [
        { step: "Task 1: Review implementation", status: "completed" },
        { step: "Task 2: Add tests", status: "in_progress" },
      ],
      commandAt: "2026-04-21T09:05:03.000Z",
    });

    await vi.waitFor(() => {
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
    });
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.apiClient.updateInteractiveCard).not.toHaveBeenCalled();
    expect(harness.runtime.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
      status: "running_notified",
      activeRunKey: "thread-native-1:turn-1",
      messageId: "msg-dm-card",
      commandCount: 1,
    });

    appendRunningProgress(harness.rolloutPath, {
      commentaryAt: "2026-04-21T09:05:10.000Z",
      commentary: "测试已经补完，我现在同步文档。",
      commandAt: "2026-04-21T09:05:11.000Z",
    });

    await vi.waitFor(() => {
      expect(harness.apiClient.updateInteractiveCard).toHaveBeenCalledTimes(1);
    });
    expect(harness.runtime.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
      status: "running_notified",
      commandCount: 2,
      latestPublicMessage: "测试已经补完，我现在同步文档。",
    });

    appendCompletion(
      harness.rolloutPath,
      "2026-04-21T09:05:20.000Z",
      "2026-04-21T09:05:21.000Z",
      "Task 1 已完成，测试和文档也已同步。",
    );

    await vi.waitFor(() => {
      expect(harness.apiClient.updateInteractiveCard).toHaveBeenCalledTimes(2);
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledTimes(1);
    });
    expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: expect.stringContaining("thread-native-1:2026-04-21T09:05:21.000Z:"),
    });
    expect(harness.runtime.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
      status: "completed",
      messageId: "msg-dm-card",
      commandCount: 2,
      lastCompletionKey: expect.stringContaining("thread-native-1:2026-04-21T09:05:21.000Z:"),
    });
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

  it("bootstraps an already-running latest turn instead of surfacing an older completed turn", async () => {
    const harness = await createHarness(harnesses);

    appendCompletion(
      harness.rolloutPath,
      "2026-04-22T11:01:53.000Z",
      "2026-04-22T11:01:54.000Z",
      "旧的一轮已经完成。",
    );
    appendRunningProgress(harness.rolloutPath, {
      startedAt: "2026-04-22T11:05:00.000Z",
      turnId: "turn-bootstrap-running",
      commentaryAt: "2026-04-22T11:05:10.000Z",
      commentary: "我正在继续整理 patent doc skill，并准备给出新的改进方案。",
      planAt: "2026-04-22T11:05:12.000Z",
      plan: [
        { step: "总结当前 skill 结构", status: "completed" },
        { step: "提出改进方案", status: "in_progress" },
      ],
      commandAt: "2026-04-22T11:05:20.000Z",
    });

    await harness.runtime.start();

    await vi.waitFor(() => {
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(harness.runtime.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
        status: "running_notified",
        activeRunKey: "thread-native-1:turn-bootstrap-running",
        latestPublicMessage: "我正在继续整理 patent doc skill，并准备给出新的改进方案。",
        commandCount: 1,
      });
    });
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastCompletionKey: expect.stringContaining("thread-native-1:2026-04-22T11:01:54.000Z:"),
      lastNotifiedCompletionKey: expect.stringContaining("thread-native-1:2026-04-22T11:01:54.000Z:"),
    });
  });

  it("ignores subagent-thread completions and only watches top-level desktop threads", async () => {
    const harness = await createHarness(harnesses, {
      threads: [
        {
          threadId: "thread-parent-1",
          title: "Main Desktop Thread",
          source: "desktop",
        },
        {
          threadId: "thread-child-1",
          title: "Review Task 1 implementation",
          source: JSON.stringify({
            subagent: {
              thread_spawn: {
                parent_thread_id: "thread-parent-1",
                depth: 1,
                agent_nickname: "review worker",
                agent_role: "worker",
              },
            },
          }),
          sourceInfo: {
            kind: "subagent",
            label: "子 agent",
            parentThreadId: "thread-parent-1",
            depth: 1,
            agentNickname: "review worker",
            agentRole: "worker",
          },
        },
      ],
    });

    await harness.runtime.start();

    await vi.waitFor(() => {
      expect(harness.runtime.store.getCodexThreadWatchState("thread-parent-1")).toBeDefined();
    });
    expect(harness.runtime.store.getCodexThreadWatchState("thread-child-1")).toBeUndefined();

    appendCompletion(
      harness.rolloutPaths["thread-child-1"],
      "2026-04-21T09:20:00.000Z",
      "2026-04-21T09:20:01.000Z",
      "child thread done",
    );

    await new Promise(resolve => setTimeout(resolve, 80));
    expect(harness.apiClient.sendInteractiveCard).not.toHaveBeenCalled();
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();

    appendCompletion(
      harness.rolloutPaths["thread-parent-1"],
      "2026-04-21T09:21:00.000Z",
      "2026-04-21T09:21:01.000Z",
      "parent thread done",
    );

    await vi.waitFor(() => {
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("suppresses desktop completion cards for recently finished Feishu-originated runs on the same thread", async () => {
    const harness = await createHarness(harnesses);

    await harness.runtime.start();
    await vi.waitFor(() => {
      expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toBeDefined();
    });

    harness.runtime.store.createRun({
      runId: "run-feishu-1",
      channel: "feishu",
      peerId: "ou_demo",
      threadId: "thread-native-1",
      sessionName: "thread-native-1",
      rootId: "main",
      status: "running",
      stage: "text",
      latestPreview: "working",
      startedAt: "2026-04-21T09:29:50.000Z",
      updatedAt: "2026-04-21T09:30:00.000Z",
    });
    harness.runtime.store.completeRun({
      runId: "run-feishu-1",
      status: "done",
      stage: "done",
      latestPreview: "finished in Feishu",
      finishedAt: "2026-04-21T09:30:02.000Z",
    });

    appendCompletion(
      harness.rolloutPath,
      "2026-04-21T09:30:01.000Z",
      "2026-04-21T09:30:01.500Z",
      "should be suppressed",
    );

    await new Promise(resolve => setTimeout(resolve, 80));
    expect(harness.apiClient.sendInteractiveCard).not.toHaveBeenCalled();
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastCompletionKey: expect.stringContaining("thread-native-1:2026-04-21T09:30:01.500Z:"),
      lastNotifiedCompletionKey: expect.stringContaining("thread-native-1:2026-04-21T09:30:01.500Z:"),
    });

    appendCompletion(
      harness.rolloutPath,
      "2026-04-21T09:32:30.000Z",
      "2026-04-21T09:32:31.000Z",
      "desktop-only completion",
    );

    await vi.waitFor(() => {
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("prefers a newer running turn over an older unseen completion when the service resumes polling", async () => {
    const harness = await createHarness(harnesses);

    const bootstrapOffset = Buffer.byteLength(
      [
        buildSessionMetaLine("thread-native-1", "desktop"),
        buildFinalAnswerLine("2026-04-21T09:00:00.000Z", "historical completion for thread-native-1"),
        buildTaskCompleteLine("2026-04-21T09:00:01.000Z"),
        "",
      ].join("\n"),
      "utf8",
    );
    harness.runtime.store.upsertCodexThreadWatchState({
      threadId: "thread-native-1",
      rolloutPath: harness.rolloutPath,
      rolloutMtime: "2026-04-21T09:00:01.000Z",
      lastReadOffset: bootstrapOffset,
      lastCompletionKey: null,
      lastNotifiedCompletionKey: null,
    });

    appendCompletion(
      harness.rolloutPath,
      "2026-04-22T11:01:53.000Z",
      "2026-04-22T11:01:54.000Z",
      "上一轮对话已经完成。",
    );
    appendRunningProgress(harness.rolloutPath, {
      startedAt: "2026-04-22T11:05:00.000Z",
      turnId: "turn-2",
      commentaryAt: "2026-04-22T11:05:10.000Z",
      commentary: "我正在继续分析 patent doc skill 的结构和改进方向。",
      planAt: "2026-04-22T11:05:12.000Z",
      plan: [
        { step: "总结当前 patent doc skill", status: "completed" },
        { step: "梳理改进方向", status: "in_progress" },
      ],
      commandAt: "2026-04-22T11:05:20.000Z",
    });

    await harness.runtime.start();

    await vi.waitFor(() => {
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(harness.runtime.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
        status: "running_notified",
        activeRunKey: "thread-native-1:turn-2",
        latestPublicMessage: "我正在继续分析 patent doc skill 的结构和改进方向。",
        commandCount: 1,
      });
    });
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.apiClient.updateInteractiveCard).not.toHaveBeenCalled();
    expect(harness.runtime.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastCompletionKey: expect.stringContaining("thread-native-1:2026-04-22T11:01:54.000Z:"),
      lastNotifiedCompletionKey: expect.stringContaining("thread-native-1:2026-04-22T11:01:54.000Z:"),
    });
  });
});

interface RuntimeHarness {
  rootDir: string;
  rolloutPath: string;
  rolloutPaths: Record<string, string>;
  runtime: Awaited<ReturnType<typeof createRuntime>>;
  apiClient: ReturnType<typeof createApiClientDouble>;
}

async function createHarness(
  harnesses: RuntimeHarness[],
  input?: {
    threads?: Array<{
      threadId: string;
      title: string;
      source: string;
      sourceInfo?: CodexCatalogThread["sourceInfo"];
    }>;
  },
): Promise<RuntimeHarness> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-desktop-completion-"));
  const threadDefinitions = input?.threads ?? [{
    threadId: "thread-native-1",
    title: "Desktop Thread",
    source: "desktop",
  }];
  const rolloutPaths: Record<string, string> = {};
  for (const thread of threadDefinitions) {
    const rolloutPath = path.join(rootDir, `${thread.threadId}.jsonl`);
    rolloutPaths[thread.threadId] = rolloutPath;
    writeFileSync(
      rolloutPath,
      [
        buildSessionMetaLine(thread.threadId, thread.source),
        buildFinalAnswerLine("2026-04-21T09:00:00.000Z", `historical completion for ${thread.threadId}`),
        buildTaskCompleteLine("2026-04-21T09:00:01.000Z"),
      ].join("\n") + "\n",
      "utf8",
    );
  }

  const apiClient = createApiClientDouble();
  const codexCatalog = createCatalogDouble(
    threadDefinitions.map(thread => ({
      ...thread,
      rolloutPath: rolloutPaths[thread.threadId],
    })),
  );
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
    rolloutPath: rolloutPaths[threadDefinitions[0].threadId],
    rolloutPaths,
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

function createCatalogDouble(input: Array<{
  threadId: string;
  title: string;
  source: string;
  rolloutPath: string;
  sourceInfo?: CodexCatalogThread["sourceInfo"];
}>): {
  listProjects: () => CodexCatalogProject[];
  getProject: (projectKey: string) => CodexCatalogProject | undefined;
  listThreads: (projectKey: string) => CodexCatalogThread[];
  getThread: (threadId: string) => CodexCatalogThread | undefined;
  listRecentConversation: (threadId: string, limit?: number) => CodexCatalogConversationItem[];
} {
  const threads: CodexCatalogThread[] = input.map(thread => ({
    threadId: thread.threadId,
    projectKey: "project-key-1",
    cwd: "D:/repo-one",
    displayName: "Repo One",
    title: thread.title,
    source: thread.source,
    sourceInfo: thread.sourceInfo,
    archived: false,
    updatedAt: "2026-04-21T09:00:01.000Z",
    createdAt: "2026-04-21T08:50:00.000Z",
    gitBranch: "main",
    cliVersion: "0.0.0",
    rolloutPath: thread.rolloutPath,
  }));
  const project: CodexCatalogProject = {
    projectKey: "project-key-1",
    cwd: "D:/repo-one",
    displayName: "Repo One",
    threadCount: threads.length,
    activeThreadCount: threads.length,
    lastUpdatedAt: "2026-04-21T09:00:01.000Z",
    gitBranch: "main",
  };

  return {
    listProjects: () => [project],
    getProject: projectKey => projectKey === project.projectKey ? project : undefined,
    listThreads: projectKey => projectKey === project.projectKey ? threads : [],
    getThread: threadId => threads.find(thread => thread.threadId === threadId),
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

function appendRunningProgress(
  rolloutPath: string,
  input: {
    startedAt?: string;
    turnId?: string;
    commentaryAt?: string;
    commentary?: string;
    planAt?: string;
    plan?: Array<{ step: string; status: string }>;
    commandAt?: string;
  },
): void {
  const lines: string[] = [];
  if (input.startedAt) {
    lines.push(buildTaskStartedLine(input.startedAt, input.turnId ?? "turn-runtime"));
  }
  if (input.commentaryAt && input.commentary) {
    lines.push(buildAgentMessageLine(input.commentaryAt, input.commentary));
  }
  if (input.planAt && input.plan) {
    lines.push(buildUpdatePlanLine(input.planAt, input.plan));
  }
  if (input.commandAt) {
    lines.push(buildShellCommandLine(input.commandAt));
  }

  if (lines.length > 0) {
    appendFileSync(rolloutPath, `${lines.join("\n")}\n`, "utf8");
  }
}

function buildSessionMetaLine(threadId: string, source = "desktop"): string {
  return JSON.stringify({
    timestamp: "2026-04-21T08:50:00.000Z",
    type: "session_meta",
    payload: {
      id: threadId,
      timestamp: "2026-04-21T08:50:00.000Z",
      cwd: "D:\\Repos\\Demo",
      cli_version: "0.116.0",
      source,
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

function buildTaskStartedLine(timestamp: string, turnId: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
    },
  });
}

function buildAgentMessageLine(timestamp: string, message: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "agent_message",
      message,
      phase: "commentary",
    },
  });
}

function buildUpdatePlanLine(
  timestamp: string,
  plan: Array<{ step: string; status: string }>,
): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({ plan }),
    },
  });
}

function buildShellCommandLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell_command",
      arguments: JSON.stringify({ command: "npm test -- tests/runtime.test.ts" }),
    },
  });
}
