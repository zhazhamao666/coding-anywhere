import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import { RunWorkerManager } from "../src/run-worker-manager.js";
import type { CodexCatalogThread, ProgressCardState, RunnerEvent } from "../src/types.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("BridgeService", () => {
  let rootDir: string;
  let store: SessionStore;
  let bridgeRootCwd: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-service-"));
    bridgeRootCwd = path.join(rootDir, "repos");
    store = new SessionStore(path.join(rootDir, "bridge.db"));
    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: bridgeRootCwd,
      repoRoot: bridgeRootCwd,
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns an idle status card for the current CA session", async () => {
    store.bindThread({
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca status",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const card = (replies[0] as { card: Record<string, unknown> }).card;
    const cardText = JSON.stringify(card);
    expect(cardText).toContain("运行状态");
    expect(cardText).toContain("当前没有运行中的任务");
    expect(readCardSummaryMarkdown(card)).not.toContain("Session");
    expect(cardText).not.toContain("停止任务");
  });

  it("shows session codex settings and applies updated model, reasoning, and speed to subsequent thread runs", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-current",
    });

    const runner = createRunnerDouble();
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: createSingleThreadCatalog({
        projectKey: "proj-current",
        displayName: "Current Project",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        threadId: "thread-current",
        title: "follow-up",
      }),
      codexPreferences: {
        defaultModel: "gpt-5.4",
        defaultReasoningEffort: "xhigh",
        defaultSpeed: "standard",
        modelOptions: ["gpt-5.4", "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.4-mini"],
        reasoningEffortOptions: ["low", "medium", "high", "xhigh"],
        speedOptions: ["standard", "fast"],
      },
    });

    const sessionReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca session",
    });
    const sessionCard = (sessionReplies[0] as { card: Record<string, unknown> }).card;
    const sessionCardText = JSON.stringify(sessionCard);
    expect(sessionCardText).toContain("当前会话已就绪");
    expect(sessionCardText).toContain("下次任务设置");
    expect(sessionCardText).toContain("计划模式");
    expect(sessionCardText).toContain("切换会话");
    expect(sessionCardText).toContain("更多信息");
    expect(sessionCardText).toContain("GPT-5.4");
    expect(sessionCardText).toContain("推理");
    expect(sessionCardText).toContain("超高");
    expect(sessionCardText).toContain("速度");
    expect(sessionCardText).toContain("标准");
    expect(sessionCardText).not.toContain("**视图**：当前会话");
    expect(sessionCardText).not.toContain("Codex 线程 ID：");
    expect(sessionCardText).toContain("\"bridgeAction\":\"set_codex_model\"");
    expect(sessionCardText).toContain("\"bridgeAction\":\"set_reasoning_effort\"");
    expect(sessionCardText).toContain("\"bridgeAction\":\"set_codex_speed\"");
    expect(sessionCardText.indexOf("GPT-5.4")).toBeLessThan(sessionCardText.indexOf("GPT-5.2-Codex"));
    expect(sessionCardText.indexOf("GPT-5.2-Codex")).toBeLessThan(sessionCardText.indexOf("GPT-5.1-Codex-Max"));
    expect(sessionCardText.indexOf("GPT-5.1-Codex-Max")).toBeLessThan(sessionCardText.indexOf("GPT-5.4-Mini"));
    expect(sessionCardText.indexOf("\"content\":\"低\"")).toBeLessThan(sessionCardText.indexOf("\"content\":\"中\""));
    expect(sessionCardText.indexOf("\"content\":\"中\"")).toBeLessThan(sessionCardText.indexOf("\"content\":\"高\""));
    expect(sessionCardText.indexOf("\"content\":\"高\"")).toBeLessThan(sessionCardText.indexOf("\"content\":\"超高\""));
    expect(sessionCardText.indexOf("\"content\":\"标准\"")).toBeLessThan(sessionCardText.indexOf("\"content\":\"快速\""));

    const updatedReply = await service.updateCodexPreferences({
      channel: "feishu",
      peerId: "ou_demo",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      speed: "fast",
    });
    expect(updatedReply).toMatchObject({
      kind: "card",
    });
    const updatedCard = (updatedReply as { card: Record<string, unknown> }).card;
    const updatedCardText = JSON.stringify(updatedCard);
    expect(updatedCardText).toContain("GPT-5.4-Mini");
    expect(updatedCardText).toContain("中");
    expect(updatedCardText).toContain("快速");

    const statusReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca status",
    });
    const statusCard = (statusReplies[0] as { card: Record<string, unknown> }).card;
    const statusCardText = JSON.stringify(statusCard);
    expect(statusCardText).toContain("GPT-5.4-Mini");
    expect(statusCardText).toContain("中");
    expect(statusCardText).toContain("快速");
    expect(statusCardText).toContain("\"bridgeAction\":\"set_codex_speed\"");

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "继续处理这个线程",
    });

    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "codex_thread",
        threadId: "thread-current",
      }),
      expect.any(String),
      expect.objectContaining({
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        speed: "fast",
      }),
      expect.any(Function),
    );
  });

  it("renders the current session card with plan mode enabled after the surface toggle is turned on", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-current",
    });
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createSingleThreadCatalog({
        projectKey: "proj-current",
        displayName: "Current Project",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        threadId: "thread-current",
        title: "follow-up",
      }),
    });

    const reply = await service.handleSessionCardUiAction({
      channel: "feishu",
      peerId: "ou_demo",
      action: "toggle_plan_mode",
    });

    expect(reply).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((reply as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前会话已就绪");
    expect(cardText).toContain("计划模式");
    expect(cardText).toContain("[开]");
    expect(cardText).toContain("直接发送你的需求，我会按计划模式处理");
    expect(cardText).toContain("\"bridgeAction\":\"toggle_plan_mode\"");
  });

  it("consumes plan-next-message mode once and resets the session card back to normal", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-current",
    });
    store.upsertSurfaceInteractionState({
      channel: "feishu",
      peerId: "ou_demo",
      sessionMode: "plan_next_message",
      diagnosticsOpen: false,
    });

    const runner = createRunnerDouble();
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: createSingleThreadCatalog({
        projectKey: "proj-current",
        displayName: "Current Project",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        threadId: "thread-current",
        title: "follow-up",
      }),
    });

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "先帮我梳理这个重构方案",
    });

    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "codex_thread",
        threadId: "thread-current",
      }),
      expect.stringContaining("/plan 先帮我梳理这个重构方案"),
      expect.any(Function),
    );

    const sessionReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca session",
    });
    const cardText = JSON.stringify((sessionReplies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("[关]");
    expect(cardText).not.toContain("[开]");
  });

  it("inline-replaces the session card with diagnostics and can switch back to the main session view", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-current",
    });
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createSingleThreadCatalog({
        projectKey: "proj-current",
        displayName: "Current Project",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        threadId: "thread-current",
        title: "follow-up",
      }),
    });

    const diagnosticsReply = await service.handleSessionCardUiAction({
      channel: "feishu",
      peerId: "ou_demo",
      action: "open_diagnostics",
    });
    const diagnosticsText = JSON.stringify((diagnosticsReply as { card: Record<string, unknown> }).card);
    expect(diagnosticsText).toContain("上下文");
    expect(diagnosticsText).toContain("最近运行");
    expect(diagnosticsText).toContain("返回当前会话");
    expect(diagnosticsText).not.toContain("下次任务设置");

    const sessionReply = await service.handleSessionCardUiAction({
      channel: "feishu",
      peerId: "ou_demo",
      action: "close_diagnostics",
    });
    const sessionText = JSON.stringify((sessionReply as { card: Record<string, unknown> }).card);
    expect(sessionText).toContain("当前会话已就绪");
    expect(sessionText).toContain("下次任务设置");
    expect(sessionText).not.toContain("返回当前会话");
  });

  it("closes diagnostics when the user reopens the session card or toggles plan mode", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-current",
    });
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createSingleThreadCatalog({
        projectKey: "proj-current",
        displayName: "Current Project",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        threadId: "thread-current",
        title: "follow-up",
      }),
    });

    await service.handleSessionCardUiAction({
      channel: "feishu",
      peerId: "ou_demo",
      action: "open_diagnostics",
    });

    const [sessionReply] = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca session",
    });
    const sessionText = JSON.stringify((sessionReply as { card: Record<string, unknown> }).card);
    expect(sessionText).toContain("下次任务设置");
    expect(sessionText).not.toContain("返回当前会话");

    await service.handleSessionCardUiAction({
      channel: "feishu",
      peerId: "ou_demo",
      action: "open_diagnostics",
    });
    const toggledReply = await service.handleSessionCardUiAction({
      channel: "feishu",
      peerId: "ou_demo",
      action: "toggle_plan_mode",
    });
    const toggledText = JSON.stringify((toggledReply as { card: Record<string, unknown> }).card);
    expect(toggledText).toContain("计划模式 [开]");
    expect(toggledText).toContain("直接发送你的需求，我会按计划模式处理");
    expect(toggledText).not.toContain("返回当前会话");
  });

  it("removes legacy open_plan_form from hub cards now that plan mode is a one-shot session toggle", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-current",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const hubReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca",
    });
    expect(hubReplies[0]).toMatchObject({ kind: "card" });
    const hubText = JSON.stringify((hubReplies[0] as { card: Record<string, unknown> }).card);
    expect(hubText).not.toContain("\"bridgeAction\":\"open_plan_form\"");
    expect(hubText).not.toContain("\"bridgeAction\":\"submit_plan_form\"");
  });

  it("hides git app directives in the DM current session card and keeps only the compact git summary", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-current",
    });

    const repoDir = createGitRepo(rootDir, "bridge-session-git");
    writeFileSync(path.join(repoDir, "alpha.txt"), "alpha\n", "utf8");
    writeFileSync(path.join(repoDir, "beta.txt"), "beta\n", "utf8");
    git(repoDir, ["add", "alpha.txt", "beta.txt"]);
    git(repoDir, ["commit", "-m", "feat: add two files"]);
    const repoCwd = repoDir.replace(/\\/g, "/");

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-current"
          ? {
              projectKey: "proj-current",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              threadCount: 1,
              activeThreadCount: 1,
              lastUpdatedAt: "2026-03-30T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn((threadId: string) => threadId === "thread-current"
          ? {
              threadId: "thread-current",
              projectKey: "proj-current",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              title: "follow-up",
              source: "vscode",
              archived: false,
              updatedAt: "2026-03-30T00:00:00.000Z",
              createdAt: "2026-03-29T00:00:00.000Z",
              gitBranch: "main",
              cliVersion: "0.116.0",
              rolloutPath: "D:/rollout",
            }
          : undefined),
        listRecentConversation: vi.fn(() => [
          {
            role: "user" as const,
            text: "请把这轮改动同步到当前会话卡里。",
            timestamp: "2026-04-20T10:05:00.000Z",
          },
          {
            role: "assistant" as const,
            text: [
              "都通过了。当前分支就是 main，提交是 24e5edd，工作区干净。",
              `::git-stage{cwd=\"${repoCwd}\"}`,
              `::git-commit{cwd=\"${repoCwd}\"}`,
            ].join("\n"),
            timestamp: "2026-04-20T10:10:00.000Z",
          },
        ]),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca session",
    });

    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("都通过了。当前分支就是 main，提交是 24e5edd，工作区干净。");
    expect(cardText).toContain("2 个文件已更改");
    expect(cardText).not.toContain("::git-stage");
    expect(cardText).not.toContain("::git-commit");
  });

  it("shows the current live run for the same surface and stops it on /ca stop", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-current",
      projectName: "Current Project",
    });

    let rejectRun: ((error: Error) => void) | undefined;
    const runner = {
      createThread: vi.fn(async () => ({
        exitCode: 0,
        events: [],
        threadId: "thread-current",
      })),
      ensureSession: vi.fn(async () => undefined),
      cancel: vi.fn(async () => {
        rejectRun?.(new Error("RUN_CANCELED"));
      }),
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
        onEvent?.({ type: "text", content: "**明确待办**\n- still working" });
        return await new Promise<never>((_resolve, reject) => {
          rejectRun = reject as (error: Error) => void;
        });
      }),
    };
    const workerManager = new RunWorkerManager({ maxConcurrentRuns: 1 });
    const service = new BridgeService({
      store,
      runner,
      workerManager,
      codexCatalog: createSingleThreadCatalog({
        projectKey: "proj-current",
        displayName: "Current Project",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        threadId: "thread-current",
        title: "follow-up",
      }),
    });

    const runPromise = service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "继续处理这个线程",
    });

    await vi.waitFor(() => {
      expect(workerManager.getRuntimeSnapshot().activeCount).toBe(1);
    });

    const statusReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca status",
    });

    expect(statusReplies).toHaveLength(1);
    expect(statusReplies[0]).toMatchObject({
      kind: "card",
    });
    const statusCard = (statusReplies[0] as { card: Record<string, unknown> }).card;
    const statusCardText = JSON.stringify(statusCard);
    expect(statusCardText).toContain("run-");
    expect(statusCardText).toContain("still working");
    expect(statusCardText).toContain("运行中");
    expect(statusCardText).toContain("停止任务");
    expect(readCardSummaryMarkdown(statusCard)).toContain("当前会话");
    expect(readCardSummaryMarkdown(statusCard)).not.toContain("Session");
    expect(statusCardText).not.toContain("**明确待办**");

    const hubReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca",
    });
    const hubCard = (hubReplies[0] as { card: Record<string, unknown> }).card;
    const hubCardText = JSON.stringify(hubCard);
    expect(hubCardText).toContain("当前会话已就绪");
    expect(hubCardText).not.toContain("停止任务");
    expect(hubCardText).not.toContain("当前运行");
    expect(hubCardText).toContain("更多信息");
    expect(hubCardText).not.toContain("still working");

    const sessionReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca session",
    });
    const sessionCard = (sessionReplies[0] as { card: Record<string, unknown> }).card;
    expect(JSON.stringify(sessionCard)).not.toContain("停止任务");
    expect(readCardSummaryMarkdown(sessionCard)).toContain("当前会话");
    expect(readCardSummaryMarkdown(sessionCard)).not.toContain("Session");

    const stopReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca stop",
    });

    expect(stopReplies).toEqual([
      {
        kind: "system",
        text: "[ca] stop requested for current run",
      },
    ]);
    expect(runner.cancel).toHaveBeenCalledTimes(1);
    await expect(runPromise).resolves.toEqual([
      {
        kind: "system",
        text: "[ca] run canceled",
      },
    ]);
  });

  it("returns a project-binding entry card for a bound group chat that has not selected a thread yet", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });
    store.createCodexThread({
      threadId: "thread-current",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "codex-proj-current-thread-current",
      title: "follow-up",
      ownerOpenId: "ou_demo",
      status: "warm",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前群已绑定项目");
    expect(cardText).toContain("\"tag\":\"button\"");
    expect(cardText).toContain("Current Project");
    expect(cardText).toContain("未绑定");
    expect(cardText).toContain("查看项目");
    expect(cardText).toContain("选择会话");
    expect(cardText).toContain("新会话");
    expect(cardText).not.toContain("更多信息");
    expect(cardText).not.toContain("下次任务设置");
    expect(cardText).not.toContain("计划模式");
  });

  it("returns a project-selection entry card in DM when no project has been selected yet", async () => {
    store.createProject({
      projectId: "proj-alpha",
      name: "Alpha",
      cwd: path.join(bridgeRootCwd, "alpha"),
      repoRoot: path.join(bridgeRootCwd, "alpha"),
    });
    store.upsertProjectChat({
      projectId: "proj-alpha",
      chatId: "oc_chat_alpha",
      groupMessageType: "thread",
      title: "Codex | Alpha",
    });
    store.createProject({
      projectId: "proj-beta",
      name: "Beta",
      cwd: path.join(bridgeRootCwd, "beta"),
      repoRoot: path.join(bridgeRootCwd, "beta"),
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("开始使用");
    expect(cardText).toContain("未选择");
    expect(cardText).toContain("查看项目");
    expect(cardText).toContain("/ca project list");
    expect(cardText).not.toContain("停止任务");
    expect(cardText).not.toContain("计划模式");
    expect(cardText).not.toContain("下次任务设置");
    expect(cardText).not.toContain("切换会话");
  });

  it("returns a project-selection entry card in a new group chat before any project is bound", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_fresh",
      chatType: "group",
      text: "/ca",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前群未绑定项目");
    expect(cardText).toContain("查看项目");
    expect(cardText).toContain("/ca project list");
    expect(cardText).not.toContain("当前会话已就绪");
    expect(cardText).not.toContain("切换会话");
    expect(cardText).not.toContain("新会话");
    expect(cardText).not.toContain("计划模式");
    expect(cardText).not.toContain("下次任务设置");
  });

  it("shows only the thread title in the DM current-session card when the session id already points at the same native thread", async () => {
    store.createProject({
      projectId: "proj-native",
      name: "coding-anywhere",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-native-current",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => [{
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-03-30T00:00:00.000Z",
          gitBranch: "main",
        }]),
        getProject: vi.fn(() => ({
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-03-30T00:00:00.000Z",
          gitBranch: "main",
        })),
        listThreads: vi.fn(() => []),
        getThread: vi.fn(() => ({
          threadId: "thread-native-current",
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          title: "native follow-up",
          source: "vscode",
          archived: false,
          updatedAt: "2026-03-30T00:00:00.000Z",
          createdAt: "2026-03-29T00:00:00.000Z",
          gitBranch: "main",
          cliVersion: "0.116.0",
          rolloutPath: "D:/rollout",
        })),
        listRecentConversation: vi.fn(() => []),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const card = (replies[0] as { card: Record<string, unknown> }).card;
    const cardText = JSON.stringify(card);
    expect(cardText).toContain("**会话**：native follow-up");
    expect(readCardSummaryMarkdown(card)).not.toContain("Session");
    expect(cardText).not.toContain("thread-native-current");
    expect(cardText).not.toContain("**会话**：thread-native-current · native follow-up");
  });

  it("rejects registered Feishu topic session cards instead of treating them as supported UI", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.createCodexThread({
      threadId: "thread-current",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "codex-proj-current-thread-current",
      title: "follow-up",
      ownerOpenId: "ou_demo",
      status: "warm",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
      text: "/ca",
    });

    expect(replies).toEqual([{
      kind: "system",
      text: expect.stringContaining("不支持飞书主题入口"),
    }]);
  });

  it("keeps DM session-card state on the same surface even when DM callbacks carry chatId", async () => {
    const projectCwd = path.join(bridgeRootCwd, "alpha");
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-alpha-current",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => [{
          projectKey: "project-alpha",
          cwd: projectCwd,
          displayName: "Alpha",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-04-26T00:00:00.000Z",
          gitBranch: "main",
        }]),
        getProject: vi.fn(() => ({
          projectKey: "project-alpha",
          cwd: projectCwd,
          displayName: "Alpha",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-04-26T00:00:00.000Z",
          gitBranch: "main",
        })),
        listThreads: vi.fn(() => []),
        getThread: vi.fn((threadId: string) => threadId === "thread-alpha-current"
          ? {
              threadId: "thread-alpha-current",
              projectKey: "project-alpha",
              cwd: projectCwd,
              displayName: "Alpha",
              title: "Alpha follow-up",
              source: "vscode",
              archived: false,
              updatedAt: "2026-04-26T00:00:00.000Z",
              createdAt: "2026-04-25T00:00:00.000Z",
              gitBranch: "main",
              cliVersion: "0.116.0",
              rolloutPath: "D:/rollout",
            }
          : undefined),
        listRecentConversation: vi.fn(() => []),
      },
    } as any);

    const toggled = await service.handleSessionCardUiAction({
      channel: "feishu",
      peerId: "ou_demo",
      chatType: "p2p",
      chatId: "oc_dm_card",
      action: "toggle_plan_mode",
    });

    expect(toggled).toMatchObject({ kind: "card" });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca",
    });

    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前会话已就绪");
    expect(cardText).toContain("计划模式 [开]");
    expect(cardText).not.toContain("当前群");
  });

  it("creates and binds a native thread for the first DM prompt, wraps prompts and emits lifecycle snapshots", async () => {
    const runner = createRunnerDouble();
    const snapshots: ProgressCardState[] = [];
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage(
      {
        channel: "feishu",
        peerId: "ou_demo",
        text: "请先查看当前目录，然后运行测试",
      },
      {
        onProgress: snapshot => {
          snapshots.push(snapshot);
        },
      },
    );

    expect(runner.createThread).toHaveBeenCalledWith(
      {
        cwd: bridgeRootCwd,
        prompt: expect.stringContaining("Session: 请先查看当前目录，然后运行测试"),
      },
    );
    const createThreadCalls = runner.createThread.mock.calls as unknown as Array<[{
      prompt: string;
    }]>;
    expect(createThreadCalls[0]![0].prompt).not.toContain("Topic:");
    expect(runner.ensureSession).toHaveBeenCalledWith({
      targetKind: "codex_thread",
      threadId: "thread-created",
      sessionName: "thread-created",
      cwd: bridgeRootCwd,
    });
    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      {
        targetKind: "codex_thread",
        threadId: "thread-created",
        sessionName: "thread-created",
        cwd: bridgeRootCwd,
      },
      expect.stringContaining("[bridge-context]"),
      expect.any(Function),
    );

    const prompt = runner.submitVerbatim.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("root_name: main");
    expect(prompt).toContain(`root_path: ${bridgeRootCwd}`);
    expect(prompt).toContain("Discover projects and repositories under this root yourself.");
    expect(prompt).toContain("Do not tell the user to use /ca repo commands");
    expect(prompt).toContain("[user-message]");
    expect(prompt).toContain("请先查看当前目录，然后运行测试");

    expect(snapshots.map(snapshot => snapshot.stage)).toEqual([
      "received",
      "resolving_context",
      "ensuring_session",
      "session_ready",
      "submitting_prompt",
      "waiting_first_event",
      "tool_call",
      "text",
      "done",
    ]);
    expect(snapshots[0]).toMatchObject({
      status: "queued",
      rootName: "main",
    });
    expect(snapshots[3]).toMatchObject({
      stage: "session_ready",
      sessionName: "thread-created",
    });
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "测试已经执行完成",
      },
    ]);
    expect(store.getCodexWindowBinding("feishu", "ou_demo")).toMatchObject({
      codexThreadId: "thread-created",
    });

    const observabilityStore = store as any;
    expect(observabilityStore.listRuns({ limit: 10 })).toEqual([
      expect.objectContaining({
        channel: "feishu",
        peerId: "ou_demo",
        sessionName: "thread-created",
        status: "done",
        stage: "done",
      }),
    ]);
    expect(observabilityStore.listRunEvents(snapshots[0]?.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "bridge",
          stage: "received",
        }),
        expect.objectContaining({
          source: "runner",
          stage: "tool_call",
        }),
      ]),
    );
  });

  it("emits lifecycle and tool snapshots while the runner stream is active", async () => {
    const runner = createRunnerDouble();
    const snapshots: ProgressCardState[] = [];
    const service = new BridgeService({
      store,
      runner,
    });

    await service.handleMessage(
      {
        channel: "feishu",
        peerId: "ou_demo",
        text: "执行测试",
      },
      {
        onProgress: snapshot => {
          snapshots.push(snapshot);
        },
      },
    );

    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "ensuring_session",
          status: "preparing",
          preview: "[ca] ensuring session",
        }),
        expect.objectContaining({
          stage: "tool_call",
          status: "tool_active",
          latestTool: "command_execution",
          commandCount: 1,
          preview: "Ran 1 command",
        }),
      ]),
    );
  });

  it("keeps the runner error when progress delivery fails during an error snapshot", async () => {
    const runnerError = "\u001b[31mvitest failed\u001b[0m\nexpected true to be false";
    const deliveryError = new Error("Request failed with status code 400");
    const events: RunnerEvent[] = [
      { type: "error", content: runnerError },
    ];
    const runner = {
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
        optionsOrOnEvent?: { images?: string[] } | ((event: RunnerEvent) => void | Promise<void>),
        maybeOnEvent?: (event: RunnerEvent) => void | Promise<void>,
      ) => {
        const onEvent = typeof optionsOrOnEvent === "function"
          ? optionsOrOnEvent
          : maybeOnEvent;

        for (const event of events) {
          await onEvent?.(event);
        }

        return {
          exitCode: 1,
          events,
        };
      }),
    };
    const service = new BridgeService({
      store,
      runner,
    });

    await expect(service.handleMessage(
      {
        channel: "feishu",
        peerId: "ou_demo",
        text: "执行会失败的测试",
      },
      {
        onProgress: snapshot => {
          if (snapshot.status === "error") {
            throw deliveryError;
          }
        },
      },
    )).rejects.toThrow(runnerError);

    const observabilityStore = store as any;
    const [run] = observabilityStore.listRuns({ limit: 1 });
    expect(run).toMatchObject({
      status: "error",
      stage: "error",
      errorText: runnerError,
    });
    expect(run.errorText).not.toBe("Request failed with status code 400");
    expect(observabilityStore.listRunEvents(run.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "system",
          preview: "[ca] delivery failed: Request failed with status code 400",
        }),
      ]),
    );
  });

  it("still emits CA lifecycle snapshots for text-only runs", async () => {
    const runner = createRunnerDouble([
      { type: "text", content: "响应正常。" },
      { type: "done", content: "响应正常。" },
    ]);
    const snapshots: ProgressCardState[] = [];
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage(
      {
        channel: "feishu",
        peerId: "ou_demo",
        text: "test",
      },
      {
        onProgress: snapshot => {
          snapshots.push(snapshot);
        },
      },
    );

    expect(snapshots.map(snapshot => snapshot.stage)).toContain("waiting_first_event");
    expect(snapshots.map(snapshot => snapshot.stage)).toContain("text");
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "响应正常。",
      },
    ]);
  });

  it("consumes staged surface assets, forwards only images to Codex, and describes file metadata", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });
    store.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      messageId: "om_image_1",
      resourceKey: "img_dm_1",
      localPath: "D:/assets/one.png",
      fileName: "one.png",
      mimeType: "image/png",
      fileSize: 1024,
    });
    store.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      messageId: "om_file_1",
      resourceType: "file",
      resourceKey: "file_dm_1",
      localPath: "D:/assets/notes.md",
      fileName: "notes.md",
      mimeType: "text/markdown",
      fileSize: 2048,
    });
    store.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      messageId: "om_file_2",
      resourceType: "file",
      resourceKey: "file_dm_2",
      localPath: "D:/assets/diagram.drawio",
      fileName: "diagram.drawio",
      mimeType: "application/xml",
      fileSize: 4096,
    });

    const runner = createRunnerDouble([
      { type: "text", content: "结合图片分析完成。" },
      { type: "done", content: "结合图片分析完成。" },
    ]);
    const service = new BridgeService({
      store,
      runner,
    });

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "请结合刚才的图片继续分析",
    });

    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      {
        targetKind: "codex_thread",
        threadId: "thread-created",
        sessionName: "thread-created",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      },
      expect.stringContaining("[bridge-attachments]"),
      {
        images: ["D:/assets/one.png"],
      },
      expect.any(Function),
    );
    const prompt = runner.submitVerbatim.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("image_count: 1");
    expect(prompt).toContain("file_count: 2");
    expect(prompt).toContain("image_1: file_name=one.png; local_path=D:/assets/one.png; source_message_id=om_image_1");
    expect(prompt).toContain("file_1: file_name=notes.md; local_path=D:/assets/notes.md; source_message_id=om_file_1; mime_type=text/markdown; file_size=2048; semantic_type=markdown; encoding=utf-8");
    expect(prompt).toContain("file_2: file_name=diagram.drawio; local_path=D:/assets/diagram.drawio; source_message_id=om_file_2; mime_type=application/xml; file_size=4096; semantic_type=drawio; encoding=utf-8");
    expect(prompt).toContain("Use local_path");
    expect(prompt).toContain("Do not ask the user to upload these attachments again");
    expect(prompt).toContain("Treat local_path values as internal-only handles");
    expect(prompt).toContain("Markdown attachments are UTF-8 text files");
    expect(prompt).toContain("draw.io attachments are editable XML diagram sources");
    expect(store.listPendingBridgeAssetsForSurface({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
    })).toEqual([]);

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "再继续一次",
    });

    expect(runner.submitVerbatim.mock.calls[1]).toHaveLength(3);
    expect(runner.submitVerbatim.mock.calls[1]?.[2]).toEqual(expect.any(Function));
    expect((runner.submitVerbatim.mock.calls[1]?.[1] as string)).not.toContain("[bridge-attachments]");
  });

  it("restores staged images when the runner fails before emitting any event", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });
    store.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      messageId: "om_image_1",
      resourceKey: "img_dm_1",
      localPath: "D:/assets/one.png",
      fileName: "one.png",
      mimeType: "image/png",
      fileSize: 1024,
    });

    const runner = {
      createThread: vi.fn(async () => ({
        exitCode: 0,
        events: [],
        threadId: "thread-created",
      })),
      ensureSession: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      submitVerbatim: vi.fn(async () => {
        throw new Error("CODEX_LAUNCH_FAILED");
      }),
    };
    const service = new BridgeService({
      store,
      runner,
    });

    await expect(service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "请结合刚才的图片继续分析",
    })).rejects.toThrow("CODEX_LAUNCH_FAILED");

    expect(store.listPendingBridgeAssetsForSurface({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
    })).toEqual([
      expect.objectContaining({
        status: "pending",
        runId: null,
        localPath: "D:/assets/one.png",
      }),
    ]);
  });

  it("strips bridge-image directives from assistant text and returns image replies", async () => {
    const projectCwd = path.join(bridgeRootCwd, "coding-anywhere");
    const imagePath = path.join(projectCwd, "artifacts", "result.png");
    mkdirSync(path.dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, "png");

    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: projectCwd,
      repoRoot: projectCwd,
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });

    const directiveText = [
      "已生成结果图。",
      "[bridge-image]",
      JSON.stringify({
        images: [{
          path: imagePath,
          caption: "处理结果图",
        }],
      }),
      "[/bridge-image]",
    ].join("\n");
    const runner = createRunnerDouble([
      { type: "text", content: directiveText },
      { type: "done", content: directiveText },
    ]);
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "请返回结果图",
    });

    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "已生成结果图。",
      },
      {
        kind: "image",
        localPath: imagePath,
        caption: "处理结果图",
      },
    ]);
  });

  it("strips bridge-assets directives and returns image and file replies", async () => {
    const projectCwd = path.join(bridgeRootCwd, "coding-anywhere");
    const imagePath = path.join(projectCwd, "artifacts", "result.png");
    const markdownPath = path.join(projectCwd, "artifacts", "notes.md");
    mkdirSync(path.dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, "png");
    writeFileSync(markdownPath, "# Notes\n");

    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: projectCwd,
      repoRoot: projectCwd,
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });

    const directiveText = [
      "已生成结果资源。",
      "[bridge-assets]",
      JSON.stringify({
        assets: [
          {
            kind: "image",
            path: imagePath,
            caption: "处理结果图",
          },
          {
            kind: "file",
            path: markdownPath,
            file_name: "report.md",
            caption: "Markdown 预览源文件",
            presentation: "markdown_preview",
          },
        ],
      }),
      "[/bridge-assets]",
    ].join("\n");
    const runner = createRunnerDouble([
      { type: "text", content: directiveText },
      { type: "done", content: directiveText },
    ]);
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "请返回结果资源",
    });

    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "已生成结果资源。",
      },
      {
        kind: "image",
        localPath: imagePath,
        caption: "处理结果图",
      },
      {
        kind: "file",
        localPath: markdownPath,
        fileName: "report.md",
        caption: "Markdown 预览源文件",
        fileSize: 8,
        semanticType: "markdown",
        presentation: "markdown_preview",
      },
    ]);
  });

  it("degrades disallowed bridge-image paths into readable system text", async () => {
    const projectCwd = path.join(bridgeRootCwd, "coding-anywhere");
    const outsideImagePath = path.join(rootDir, "outside.png");
    writeFileSync(outsideImagePath, "png");

    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: projectCwd,
      repoRoot: projectCwd,
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });

    const directiveText = [
      "图片已生成。",
      "[bridge-image]",
      JSON.stringify({
        images: [{
          path: outsideImagePath,
          caption: "不允许的路径",
        }],
      }),
      "[/bridge-image]",
    ].join("\n");
    const runner = createRunnerDouble([
      { type: "text", content: directiveText },
      { type: "done", content: directiveText },
    ]);
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "请返回结果图",
    });

    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "图片已生成。",
      },
      {
        kind: "system",
        text: "[ca] image unavailable: disallowed path outside.png",
      },
    ]);
    expect(JSON.stringify(replies)).not.toContain(outsideImagePath);
  });

  it("degrades invalid bridge-assets file paths into readable system text", async () => {
    const projectCwd = path.join(bridgeRootCwd, "coding-anywhere");
    const missingPath = path.join(projectCwd, "artifacts", "missing.md");
    mkdirSync(projectCwd, { recursive: true });

    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: projectCwd,
      repoRoot: projectCwd,
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });

    const directiveText = [
      "文件已生成。",
      "[bridge-assets]",
      JSON.stringify({
        assets: [{
          kind: "file",
          path: missingPath,
          file_name: "missing.md",
        }],
      }),
      "[/bridge-assets]",
    ].join("\n");
    const runner = createRunnerDouble([
      { type: "text", content: directiveText },
      { type: "done", content: directiveText },
    ]);
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "请返回文件",
    });

    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "文件已生成。",
      },
      {
        kind: "system",
        text: "[ca] asset unavailable: file not found missing.md",
      },
    ]);
    expect(JSON.stringify(replies)).not.toContain(missingPath);
  });

  it("persists bridge-managed plan interactions from runner events and exposes them on the final progress snapshot", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });

    const runner = createRunnerDouble([
      {
        type: "waiting",
        content: "梳理两种改造路径; 等待用户选择下一步",
        planTodos: [
          {
            text: "梳理两种改造路径",
            completed: true,
          },
          {
            text: "等待用户选择下一步",
            completed: false,
          },
        ],
      },
      {
        type: "text",
        content: "我先把两条改造路径收敛出来，方便你在飞书里直接选择。",
        planInteraction: {
          question: "你希望我下一步先做哪件事？",
          choices: [
            {
              choiceId: "architecture",
              label: "先梳理架构",
              description: "只输出改造边界与影响面，不改代码。",
              responseText: "先梳理架构与改造边界，不要直接改代码。",
            },
            {
              choiceId: "tests",
              label: "先补测试",
              description: "优先补齐验证路径和风险防线。",
              responseText: "先补测试和验证路径，不要直接改代码。",
            },
          ],
        },
      },
      {
        type: "done",
        content: "我先把两条改造路径收敛出来，方便你在飞书里直接选择。",
      },
    ]);
    const snapshots: ProgressCardState[] = [];
    const service = new BridgeService({
      store,
      runner,
    });

    await service.handleMessage(
      {
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        text: "/plan 帮我先梳理改造方案，不要直接改代码",
      },
      {
        onProgress: snapshot => {
          snapshots.push(snapshot);
        },
      },
    );

    expect(snapshots.at(-1)).toMatchObject({
      status: "done",
      planTodos: [
        {
          text: "梳理两种改造路径",
          completed: true,
        },
        {
          text: "等待用户选择下一步",
          completed: false,
        },
      ],
      planInteraction: {
        interactionId: expect.any(String),
        question: "你希望我下一步先做哪件事？",
        choices: expect.arrayContaining([
          expect.objectContaining({
            choiceId: "architecture",
            label: "先梳理架构",
          }),
        ]),
      },
    });

    const planStore = store as any;
    expect(
      planStore.getLatestPendingPlanInteractionForSurface({
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
      }),
    ).toMatchObject({
      threadId: "thread-created",
      question: "你希望我下一步先做哪件事？",
      status: "pending",
    });
  });

  it("coalesces streamed text chunks into a single backend observability text event", async () => {
    const runner = createRunnerDouble([
      { type: "text", content: "使用" },
      { type: "text", content: "使用 `using-superpowers`" },
      { type: "text", content: "使用 `using-superpowers` 技能" },
      { type: "done", content: "使用 `using-superpowers` 技能" },
    ]);
    const snapshots: ProgressCardState[] = [];
    const service = new BridgeService({
      store,
      runner,
    });

    await service.handleMessage(
      {
        channel: "feishu",
        peerId: "ou_demo",
        text: "test",
      },
      {
        onProgress: snapshot => {
          snapshots.push(snapshot);
        },
      },
    );

    const observabilityStore = store as any;
    const textEvents = observabilityStore
      .listRunEvents(snapshots[0]?.runId)
      .filter((event: { source: string; stage: string }) => event.source === "runner" && event.stage === "text");

    expect(textEvents).toEqual([
      expect.objectContaining({
        preview: "使用 `using-superpowers` 技能",
      }),
    ]);
    expect(snapshots.filter(snapshot => snapshot.stage === "text")).toHaveLength(3);
  });

  it("routes CA help and unknown subcommands to the correct entry card for the current surface state", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca repo list",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("开始使用");
    expect(cardText).not.toContain("CA Hub");
    expect(cardText).toContain("查看项目");
    expect(cardText).not.toContain("切换会话");
  });

  it("rejects /ca new inside a Feishu topic without creating a pending session", async () => {
    store.createProject({
      projectId: "proj-a",
      name: "coding-anywhere",
      cwd: path.join(rootDir, "coding-anywhere"),
      repoRoot: path.join(rootDir, "coding-anywhere"),
    });
    store.createCodexThread({
      threadId: "thread-a",
      projectId: "proj-a",
      feishuThreadId: "omt_1",
      chatId: "oc_chat_1",
      anchorMessageId: "om_anchor",
      latestMessageId: "om_anchor",
      sessionName: "codex-proj-a-thread-a",
      title: "feishu-nav",
      ownerOpenId: "ou_demo",
      status: "warm",
    });

    const runner = createRunnerDouble();
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_1",
      surfaceType: "thread",
      surfaceRef: "omt_1",
      text: "/ca new",
    });

    const updatedThread = store.getCodexThreadBySurface("oc_chat_1", "omt_1");

    expect(runner.createThread).not.toHaveBeenCalled();
    expect(runner.ensureSession).not.toHaveBeenCalled();
    expect(runner.submitVerbatim).not.toHaveBeenCalled();
    expect(runner.close).not.toHaveBeenCalled();
    expect(updatedThread?.threadId).toBe("thread-a");
    expect(updatedThread?.title).toBe("feishu-nav");
    expect(replies).toEqual([{
      kind: "system",
      text: expect.stringContaining("不支持飞书主题入口"),
    }]);
  });

  it("prepares a fresh DM session on /ca new without starting a Codex run", async () => {
    const projectCwd = path.join(bridgeRootCwd, "coding-anywhere");
    store.createProject({
      projectId: "proj-current",
      name: "coding-anywhere",
      cwd: projectCwd,
      repoRoot: projectCwd,
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-old",
    });

    const runner = createRunnerDouble();
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-current"
          ? {
              projectKey: "proj-current",
              cwd: projectCwd,
              displayName: "coding-anywhere",
              threadCount: 1,
              activeThreadCount: 1,
              lastUpdatedAt: "2026-03-28T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn((threadId: string) => threadId === "thread-old"
          ? {
              threadId: "thread-old",
              projectKey: "proj-current",
              cwd: projectCwd,
              displayName: "coding-anywhere",
              title: "old conversation",
              source: "vscode",
              archived: false,
              updatedAt: "2026-03-28T00:00:00.000Z",
              createdAt: "2026-03-27T00:00:00.000Z",
              gitBranch: "main",
              cliVersion: "0.116.0",
              rolloutPath: "D:/rollout",
            }
          : undefined),
        listRecentConversation: vi.fn(() => []),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca new",
    });

    expect(runner.createThread).not.toHaveBeenCalled();
    expect(runner.ensureSession).not.toHaveBeenCalled();
    expect(runner.submitVerbatim).not.toHaveBeenCalled();
    expect(store.getCodexWindowBinding("feishu", "ou_demo")).toBeUndefined();
    expect(store.getCodexProjectSelection("feishu", "ou_demo")).toMatchObject({
      projectKey: "proj-current",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前项目已选择");
    expect(cardText).toContain("**会话**：未选择");
    expect(cardText).toContain("选择已有会话，或直接发送消息创建新会话");
    expect(cardText).toContain("选择会话");
    expect(cardText).toContain("新会话");
    expect(cardText).toContain("查看项目");
    expect(cardText).not.toContain("线程已切换");
  });

  it("binds a project chat from a CA command", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project bind proj-a oc_chat_1 coding-anywhere Demo Project",
    });

    expect(store.getProject("proj-a")).toMatchObject({
      projectId: "proj-a",
      name: "Demo Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    expect((store as any).getProjectChat("proj-a")).toMatchObject({
      chatId: "oc_chat_1",
      title: "Codex | Demo Project",
    });
    expect(replies).toEqual([
      {
        kind: "system",
        text: "[ca] project bound: proj-a -> oc_chat_1",
      },
    ]);
  });

  it("returns a project list card", async () => {
    store.createProject({
      projectId: "proj-a",
      name: "Demo Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-a",
      chatId: "oc_chat_1",
      groupMessageType: "thread",
      title: "Codex | Demo Project",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project list",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("项目列表");
    expect(cardText).toContain("proj-a");
    expect(cardText).toContain("chat=oc_chat_1");
  });

  it("renders DM catalog project list cards as single-action selection rows", async () => {
    const catalog = {
      listProjects: vi.fn(() => [{
        projectKey: "proj-native",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        displayName: "coding-anywhere",
        threadCount: 3,
        activeThreadCount: 1,
        lastUpdatedAt: "2026-04-23T10:00:00.000Z",
        gitBranch: "main",
      }]),
      getProject: vi.fn(),
      listThreads: vi.fn(() => []),
      getThread: vi.fn(),
      listRecentConversation: vi.fn(() => []),
    };
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: catalog,
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project list",
    });

    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("选择项目");
    expect(cardText).toContain("当前可用项目");
    expect(cardText).toContain("coding-anywhere");
    expect(cardText).toContain("进入项目");
    expect(cardText).not.toContain("查看线程");
    expect(cardText).not.toContain("路径：");
    expect(cardText).toContain("返回导航");
    expect(cardText).toContain("新会话");
  });

  it("keeps DM catalog project list cards on the DM path even when callbacks carry chatId", async () => {
    const catalog = {
      listProjects: vi.fn(() => [{
        projectKey: "proj-native",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        displayName: "coding-anywhere",
        threadCount: 3,
        activeThreadCount: 1,
        lastUpdatedAt: "2026-04-23T10:00:00.000Z",
        gitBranch: "main",
      }]),
      getProject: vi.fn(),
      listThreads: vi.fn(() => []),
      getThread: vi.fn(),
      listRecentConversation: vi.fn(() => []),
    };
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: catalog,
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_dm_card",
      chatType: "p2p",
      text: "/ca project list",
    });

    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("选择项目");
    expect(cardText).toContain("进入项目");
    expect(cardText).not.toContain("当前群");
    expect(cardText).not.toContain("绑定到本群");
    expect(cardText).not.toContain("已绑定其他群");
  });

  it("returns an empty project list card instead of a system message", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project list",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
      card: {
        header: {
          title: {
            content: "项目列表",
          },
        },
      },
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("暂无已注册项目");
    expect(cardText).toContain("导航");
    expect(cardText).toContain("\"command\":\"/ca\"");
    expect(cardText).not.toContain("/ca project bind <projectId> <chatId> <cwd> [name]");
  });

  it("binds the current group chat without requiring an explicit chat id", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project bind-current proj-b coding-anywhere Demo Current",
    });

    expect(store.getProject("proj-b")).toMatchObject({
      projectId: "proj-b",
      name: "Demo Current",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    expect((store as any).getProjectChat("proj-b")).toMatchObject({
      chatId: "oc_chat_current",
    });
    expect(replies).toEqual([
      {
        kind: "system",
        text: "[ca] project bound: proj-b -> oc_chat_current",
      },
    ]);
  });

  it("shows Codex catalog projects with group binding status in group project list cards", async () => {
    const currentCwd = path.join(bridgeRootCwd, "current");
    const otherCwd = path.join(bridgeRootCwd, "other");
    store.createProject({
      projectId: "project-current",
      name: "Current Project",
      cwd: currentCwd,
      repoRoot: currentCwd,
    });
    store.upsertProjectChat({
      projectId: "project-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });
    store.createProject({
      projectId: "project-other",
      name: "Other Project",
      cwd: otherCwd,
      repoRoot: otherCwd,
    });
    store.upsertProjectChat({
      projectId: "project-other",
      chatId: "oc_chat_other",
      groupMessageType: "thread",
      title: "Codex | Other Project",
    });

    const catalog = {
      listProjects: vi.fn(() => [
        {
          projectKey: "project-current",
          cwd: currentCwd,
          displayName: "Current Project",
          threadCount: 2,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-04-01T00:00:00.000Z",
          gitBranch: "main",
        },
        {
          projectKey: "project-unbound",
          cwd: path.join(bridgeRootCwd, "unbound"),
          displayName: "Unbound Project",
          threadCount: 0,
          activeThreadCount: 0,
          lastUpdatedAt: "2026-04-02T00:00:00.000Z",
          gitBranch: "feature/demo",
        },
        {
          projectKey: "project-other",
          cwd: otherCwd,
          displayName: "Other Project",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-04-03T00:00:00.000Z",
          gitBranch: "main",
        },
      ]),
      getProject: vi.fn(),
      listThreads: vi.fn(() => []),
      getThread: vi.fn(),
      listRecentConversation: vi.fn(() => []),
    };
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: catalog,
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project list",
    });

    expect(catalog.listProjects).toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ kind: "card" });
    const card = (replies[0] as { card: Record<string, unknown> }).card;
    const cardText = JSON.stringify(card);
    const visibleMarkdown = readCardAllMarkdown(card);
    expect(cardText).toContain("Codex 项目列表");
    expect(cardText).toContain("Current Project");
    expect(cardText).toContain("已绑定当前群");
    expect(cardText).toContain("Unbound Project");
    expect(cardText).toContain("未绑定");
    expect(cardText).toContain("/ca project bind-current project-unbound");
    expect(cardText).toContain("Other Project");
    expect(cardText).toContain("已绑定其他群");
    expect(cardText).not.toContain("路径：");
    expect(visibleMarkdown).not.toContain(currentCwd);
    expect(visibleMarkdown).not.toContain(otherCwd);
    expect(visibleMarkdown).not.toContain("oc_chat_current");
    expect(visibleMarkdown).not.toContain("oc_chat_other");
    expect(cardText).not.toContain("oc_chat_other");
    expect(cardText).not.toContain("/ca project bind-current project-other");
    expect(cardText).not.toContain("切换项目");
  });

  it("keeps unbound group project list footer to return-only actions", async () => {
    const projectCwd = path.join(bridgeRootCwd, "unbound");
    const catalog = {
      listProjects: vi.fn(() => [{
        projectKey: "project-unbound",
        cwd: projectCwd,
        displayName: "Unbound Project",
        threadCount: 0,
        activeThreadCount: 0,
        lastUpdatedAt: "2026-04-02T00:00:00.000Z",
        gitBranch: "main",
      }]),
      getProject: vi.fn(),
      listThreads: vi.fn(() => []),
      getThread: vi.fn(),
      listRecentConversation: vi.fn(() => []),
    };
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: catalog,
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_fresh",
      chatType: "group",
      text: "/ca project list",
    });

    const card = (replies[0] as { card: Record<string, unknown> }).card;
    const cardText = JSON.stringify(card);
    const visibleMarkdown = readCardAllMarkdown(card);
    expect(cardText).toContain("Unbound Project");
    expect(cardText).toContain("/ca project bind-current project-unbound");
    expect(visibleMarkdown).toContain("当前群**：未绑定项目");
    expect(visibleMarkdown).not.toContain("oc_chat_fresh");
    expect(cardText).not.toContain("/ca project current");
    expect(cardText).not.toContain("/ca new");
    expect(cardText).not.toContain("\"command\":\"/ca project list\"");
  });

  it("binds the current group chat to a Codex catalog project by project key", async () => {
    const projectCwd = path.join(bridgeRootCwd, "alpha");
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "project-alpha"
          ? {
              projectKey: "project-alpha",
              cwd: projectCwd,
              displayName: "Alpha",
              threadCount: 3,
              activeThreadCount: 2,
              lastUpdatedAt: "2026-04-01T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn(),
        listRecentConversation: vi.fn(() => []),
      },
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project bind-current project-alpha",
    });

    expect(store.getProject("project-alpha")).toMatchObject({
      projectId: "project-alpha",
      name: "Alpha",
      cwd: projectCwd,
      repoRoot: projectCwd,
    });
    expect((store as any).getProjectChat("project-alpha")).toMatchObject({
      chatId: "oc_chat_current",
      title: "Codex | Alpha",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ kind: "card" });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("项目已绑定");
    expect(cardText).toContain("Alpha");
    expect(cardText).toContain("oc_chat_current");
    expect(cardText).toContain("/ca thread list-current");
    expect(cardText).toContain("直接在本群发送普通消息");
  });

  it("switches the current group chat binding to an unbound Codex catalog project", async () => {
    const oldCwd = path.join(bridgeRootCwd, "old");
    const newCwd = path.join(bridgeRootCwd, "new");
    store.createProject({
      projectId: "project-old",
      name: "Old Project",
      cwd: oldCwd,
      repoRoot: oldCwd,
    });
    store.upsertProjectChat({
      projectId: "project-old",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Old Project",
    });
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "project-new"
          ? {
              projectKey: "project-new",
              cwd: newCwd,
              displayName: "New Project",
              threadCount: 1,
              activeThreadCount: 1,
              lastUpdatedAt: "2026-04-01T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn(),
        listRecentConversation: vi.fn(() => []),
      },
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project bind-current project-new",
    });

    expect((store as any).getProjectChat("project-old")).toBeUndefined();
    expect((store as any).getProjectChat("project-new")).toMatchObject({
      chatId: "oc_chat_current",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("项目已绑定");
    expect(cardText).toContain("New Project");
  });

  it("does not steal a Codex catalog project already bound to another group chat", async () => {
    const projectCwd = path.join(bridgeRootCwd, "alpha");
    store.createProject({
      projectId: "project-alpha",
      name: "Alpha",
      cwd: projectCwd,
      repoRoot: projectCwd,
    });
    store.upsertProjectChat({
      projectId: "project-alpha",
      chatId: "oc_chat_other",
      groupMessageType: "thread",
      title: "Codex | Alpha",
    });
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "project-alpha"
          ? {
              projectKey: "project-alpha",
              cwd: projectCwd,
              displayName: "Alpha",
              threadCount: 3,
              activeThreadCount: 2,
              lastUpdatedAt: "2026-04-01T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn(),
        listRecentConversation: vi.fn(() => []),
      },
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project bind-current project-alpha",
    });

    expect((store as any).getProjectChat("project-alpha")).toMatchObject({
      chatId: "oc_chat_other",
    });
    expect(store.getProjectChatByChatId("oc_chat_current")).toBeUndefined();
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("项目已绑定其他群");
    expect(cardText).toContain("oc_chat_other");
  });

  it("reports the current project bound to the active group chat", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca project current",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前项目");
    expect(cardText).toContain("proj-current");
    expect(cardText).toContain("oc_chat_current");
    expect(cardText).toContain(path.join(bridgeRootCwd, "coding-anywhere").replaceAll("\\", "\\\\"));
  });

  it("rejects Feishu topic creation from /ca thread create", async () => {
    store.createProject({
      projectId: "proj-a",
      name: "Demo Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-a",
      chatId: "oc_chat_1",
      groupMessageType: "thread",
      title: "Codex | Demo Project",
    });

    const projectThreadService = {
      createThread: vi.fn(async () => ({
        threadId: "thread-native-a",
        projectId: "proj-a",
        chatId: "oc_chat_1",
        feishuThreadId: "omt_1",
        anchorMessageId: "om_anchor",
        latestMessageId: "om_anchor",
        sessionName: "thread-native-a",
        title: "feishu-nav",
        ownerOpenId: "ou_demo",
        status: "warm",
      })),
    };
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      projectThreadService,
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca thread create proj-a feishu-nav",
    });

    expect(projectThreadService.createThread).not.toHaveBeenCalled();
    expect(replies).toEqual([
      {
        kind: "system",
        text: expect.stringContaining("飞书主题"),
      },
    ]);
    expect(replies[0]?.kind === "system" ? replies[0].text : "").toContain("不支持");
    expect(replies[0]?.kind === "system" ? replies[0].text : "").toContain("/ca new");
  });

  it("rejects Feishu topic creation from /ca thread create-current", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });

    const projectThreadService = {
      createThread: vi.fn(async () => ({
        threadId: "thread-native-current",
        projectId: "proj-current",
        chatId: "oc_chat_current",
        feishuThreadId: "omt_current",
        anchorMessageId: "om_current",
        latestMessageId: "om_current",
        sessionName: "thread-native-current",
        title: "follow-up",
        ownerOpenId: "ou_demo",
        status: "warm",
      })),
    };
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      projectThreadService,
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca thread create-current follow-up",
    });

    expect(projectThreadService.createThread).not.toHaveBeenCalled();
    expect(replies).toEqual([
      {
        kind: "system",
        text: expect.stringContaining("飞书主题"),
      },
    ]);
    expect(replies[0]?.kind === "system" ? replies[0].text : "").toContain("不支持");
    expect(replies[0]?.kind === "system" ? replies[0].text : "").toContain("/ca new");
  });

  it("lists native threads for the current bound project chat without requiring a project id", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => [{
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 2,
          activeThreadCount: 2,
          lastUpdatedAt: "2026-03-28T00:00:00.000Z",
          gitBranch: "main",
        }]),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-native"
          ? {
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              threadCount: 2,
              activeThreadCount: 2,
              lastUpdatedAt: "2026-03-28T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => [{
          threadId: "thread-native-current",
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          title: "follow-up",
          source: "vscode",
          archived: false,
          updatedAt: "2026-03-28T00:00:00.000Z",
          createdAt: "2026-03-27T00:00:00.000Z",
          gitBranch: "main",
          cliVersion: "0.116.0",
          rolloutPath: "D:/rollout",
        }]),
        getThread: vi.fn(),
        listRecentConversation: vi.fn(() => []),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca thread list-current",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("选择会话");
    expect(cardText).toContain("coding-anywhere");
    expect(cardText).toContain("follow-up");
    expect(cardText).toContain("主会话");
    expect(cardText).toContain("切换到此会话");
    expect(cardText).not.toContain("Codex 线程 ID：thread-native-current");
    expect(cardText).not.toContain("来源");
    expect(cardText).not.toContain("分支");
    expect(cardText).toContain("新会话");
  });

  it("uses direct project-switch copy instead of recorded-state wording", async () => {
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-native-current",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => [{
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-03-30T00:00:00.000Z",
          gitBranch: "main",
        }]),
        getProject: vi.fn(() => ({
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-03-30T00:00:00.000Z",
          gitBranch: "main",
        })),
        listThreads: vi.fn(() => []),
        getThread: vi.fn((threadId: string) => threadId === "thread-native-current"
          ? {
              threadId: "thread-native-current",
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              title: "native follow-up",
              source: "vscode",
              archived: false,
              updatedAt: "2026-03-30T00:00:00.000Z",
              createdAt: "2026-03-29T00:00:00.000Z",
              gitBranch: "main",
              cliVersion: "0.116.0",
              rolloutPath: "D:/rollout",
            }
          : undefined),
        listRecentConversation: vi.fn(() => []),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project switch proj-native",
    });

    const card = (replies[0] as { card: Record<string, unknown> }).card;
    const cardText = JSON.stringify(card);
    expect(cardText).toContain("当前项目已切换");
    expect(cardText).toContain("当前项目：coding-anywhere");
    expect(cardText).toContain("已退出之前绑定的会话");
    expect(cardText).toContain("下一条普通消息会在该项目下创建新会话");
    expect(cardText).not.toContain("已记录项目切换");
    expect(store.getCodexWindowBinding("feishu", "ou_demo")).toBeUndefined();
  });

  it("renders Codex subagent threads under their parent without leaking raw source JSON", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });

    const rawSubagentSource = JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: "thread-parent",
          depth: 1,
          agent_path: null,
          agent_nickname: "Gauss",
          agent_role: "worker",
        },
      },
    });
    const catalogThreads: CodexCatalogThread[] = [
      {
        threadId: "thread-child",
        projectKey: "proj-native",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        displayName: "coding-anywhere",
        title: "配置 social-link-ingest 运行环境",
        source: rawSubagentSource,
        sourceInfo: {
          kind: "subagent",
          label: "子 agent",
          parentThreadId: "thread-parent",
          depth: 1,
          agentNickname: "Gauss",
          agentRole: "worker",
        },
        archived: false,
        updatedAt: "2026-04-13T01:00:00.000Z",
        createdAt: "2026-04-13T00:30:00.000Z",
        gitBranch: "feature/subagent",
        cliVersion: "0.116.0",
        rolloutPath: "D:/rollout-child",
      },
      {
        threadId: "thread-parent",
        projectKey: "proj-native",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        displayName: "coding-anywhere",
        title: "导入小红书优化版Karpthy知识库分享",
        source: "vscode",
        sourceInfo: {
          kind: "normal",
          label: "VS Code",
        },
        archived: false,
        updatedAt: "2026-04-13T00:50:00.000Z",
        createdAt: "2026-04-13T00:00:00.000Z",
        gitBranch: "main",
        cliVersion: "0.116.0",
        rolloutPath: "D:/rollout-parent",
      },
      {
        threadId: "thread-other",
        projectKey: "proj-native",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        displayName: "coding-anywhere",
        title: "另一个母 agent 线程",
        source: "cli",
        sourceInfo: {
          kind: "normal",
          label: "CLI",
        },
        archived: false,
        updatedAt: "2026-04-13T00:40:00.000Z",
        createdAt: "2026-04-12T00:00:00.000Z",
        gitBranch: null,
        cliVersion: "0.116.0",
        rolloutPath: "D:/rollout-other",
      },
      {
        threadId: "thread-orphan-child",
        projectKey: "proj-native",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        displayName: "coding-anywhere",
        title: "缺失父会话的子任务",
        source: JSON.stringify({
          subagent: {
            thread_spawn: {
              parent_thread_id: "thread-missing",
              depth: 2,
              agent_nickname: "Meitner",
              agent_role: "explorer",
            },
          },
        }),
        sourceInfo: {
          kind: "subagent",
          label: "子 agent",
          parentThreadId: "thread-missing",
          depth: 2,
          agentNickname: "Meitner",
          agentRole: "explorer",
        },
        archived: false,
        updatedAt: "2026-04-12T23:00:00.000Z",
        createdAt: "2026-04-12T22:00:00.000Z",
        gitBranch: "feature/subagent",
        cliVersion: "0.116.0",
        rolloutPath: "D:/rollout-orphan-child",
      },
    ];
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => [{
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 4,
          activeThreadCount: 4,
          lastUpdatedAt: "2026-04-13T00:00:00.000Z",
          gitBranch: "main",
        }]),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-native"
          ? {
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              threadCount: 4,
              activeThreadCount: 4,
              lastUpdatedAt: "2026-04-13T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => catalogThreads),
        getThread: vi.fn(),
        listRecentConversation: vi.fn(() => []),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca thread list-current",
    });

    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("选择会话");
    expect(cardText).toContain("会话总数");
    expect(cardText).toContain("主会话");
    expect(cardText).toContain("└ 配置 social-link-ingest 运行环境");
    expect(cardText).toContain("子 agent · 父会话：导入小红书优化版Karpthy知识库分享（thread-parent） · 层级：1");
    expect(cardText).toContain("身份：Gauss / worker");
    expect(cardText).toContain("子 agent · 父会话：thread-missing（不在当前列表） · 层级：2");
    expect(cardText).toContain("身份：Meitner / explorer");
    expect(cardText).toContain("/ca thread switch thread-child");
    expect(cardText).toContain("/ca thread switch thread-orphan-child");
    expect(cardText).not.toContain("{\\\"subagent\\\"");
    expect(cardText).not.toContain("thread_spawn");
    expect(cardText).not.toContain("来源：");
    expect(cardText).not.toContain("分支：");

    expect(cardText.indexOf("导入小红书优化版Karpthy知识库分享")).toBeLessThan(
      cardText.indexOf("└ 配置 social-link-ingest 运行环境"),
    );
    expect(cardText.indexOf("└ 配置 social-link-ingest 运行环境")).toBeLessThan(
      cardText.indexOf("另一个母 agent 线程"),
    );
  });

  it("keeps large Codex thread selection cards within Feishu's delay-update budget", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });

    const veryLongTitle = [
      "Spec-review the DM desktop completion handoff slice in worktree",
      path.join(bridgeRootCwd, "coding-anywhere", ".worktrees", "desktop-handoff"),
      "with exhaustive notes about Feishu callbacks, token update limits, and native thread routing.",
    ].join(" ").repeat(8);
    const catalogThreads: CodexCatalogThread[] = Array.from({ length: 80 }, (_unused, index) => ({
      threadId: `thread-native-${index.toString().padStart(2, "0")}`,
      projectKey: "proj-native",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      displayName: "coding-anywhere",
      title: `${veryLongTitle} #${index}`,
      source: "vscode",
      sourceInfo: {
        kind: "normal",
        label: "VS Code",
      },
      archived: false,
      updatedAt: `2026-04-13T00:${index.toString().padStart(2, "0")}:00.000Z`,
      createdAt: "2026-04-13T00:00:00.000Z",
      gitBranch: "main",
      cliVersion: "0.116.0",
      rolloutPath: `D:/rollout-${index}`,
    }));
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => [{
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: catalogThreads.length,
          activeThreadCount: catalogThreads.length,
          lastUpdatedAt: "2026-04-13T00:00:00.000Z",
          gitBranch: "main",
        }]),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-native"
          ? {
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              threadCount: catalogThreads.length,
              activeThreadCount: catalogThreads.length,
              lastUpdatedAt: "2026-04-13T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => catalogThreads),
        getThread: vi.fn(),
        listRecentConversation: vi.fn(() => []),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca thread list-current",
    });

    const card = (replies[0] as { card: Record<string, unknown> }).card;
    const cardText = JSON.stringify(card);
    const bodyElements = (card.body as { elements?: unknown[] }).elements ?? [];
    expect(Buffer.byteLength(cardText, "utf8")).toBeLessThanOrEqual(30_000);
    expect(bodyElements.length).toBeLessThanOrEqual(16);
    expect(cardText).toContain("**已显示**：12 / 80");
    expect(cardText).toContain("/ca thread switch thread-native-79");
    expect(cardText).not.toContain("/ca thread switch thread-native-00");
    expect(cardText).not.toContain(veryLongTitle);
  });

  it("rejects switching a registered Feishu topic to a native thread", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.createCodexThread({
      threadId: "thread-legacy",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "codex-proj-current-thread-current",
      title: "follow-up",
      ownerOpenId: "ou_demo",
      status: "warm",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-native"
          ? {
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              threadCount: 2,
              activeThreadCount: 2,
              lastUpdatedAt: "2026-03-28T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn((threadId: string) => threadId === "thread-native-current"
          ? {
              threadId: "thread-native-current",
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              title: "native follow-up",
              source: "vscode",
              archived: false,
              updatedAt: "2026-03-28T00:00:00.000Z",
              createdAt: "2026-03-27T00:00:00.000Z",
              gitBranch: "main",
              cliVersion: "0.116.0",
              rolloutPath: "D:/rollout",
            }
          : undefined),
        listRecentConversation: vi.fn(() => []),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
      text: "/ca thread switch thread-native-current",
    });

    expect(store.getCodexThreadBySurface("oc_chat_current", "omt_current")).toMatchObject({
      threadId: "thread-legacy",
      sessionName: "codex-proj-current-thread-current",
      title: "follow-up",
    });
    expect(replies).toEqual([{
      kind: "system",
      text: expect.stringContaining("不支持飞书主题入口"),
    }]);
  });

  it("resumes the same native thread when a pending plan choice is selected", async () => {
    const runner = createRunnerDouble([
      {
        type: "text",
        content: "先补测试和验证路径，不要直接改代码。",
      },
      {
        type: "done",
        content: "先补测试和验证路径，不要直接改代码。",
      },
    ]);
    const service = new BridgeService({
      store,
      runner,
    });

    const planStore = store as any;
    const interaction = planStore.savePendingPlanInteraction({
      runId: "run-plan-1",
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      sessionName: "thread-created",
      question: "你希望我下一步先做哪件事？",
      choices: [
        {
          choiceId: "architecture",
          label: "先梳理架构",
          responseText: "先梳理架构与改造边界，不要直接改代码。",
        },
        {
          choiceId: "tests",
          label: "先补测试",
          responseText: "先补测试和验证路径，不要直接改代码。",
        },
      ],
    });
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    bindGroupMainlineCodexThread(store, {
      projectId: "proj-current",
      chatId: "oc_chat_current",
      threadId: "thread-created",
      projectName: "Current Project",
    });

    const replies = await service.handlePlanChoice(
      {
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        interactionId: interaction.interactionId,
        choiceId: "tests",
      },
      {
        onProgress: () => undefined,
      },
    );

    expect(runner.ensureSession).toHaveBeenCalledWith({
      targetKind: "codex_thread",
      threadId: "thread-created",
      sessionName: "thread-created",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      {
        targetKind: "codex_thread",
        threadId: "thread-created",
        sessionName: "thread-created",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      },
      expect.stringContaining("先补测试和验证路径，不要直接改代码。"),
      expect.any(Function),
    );
    expect(runner.submitVerbatim.mock.calls[0]?.[1]).toContain("先补测试和验证路径，不要直接改代码。");
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "先补测试和验证路径，不要直接改代码。",
      },
    ]);
    expect(planStore.getPendingPlanInteraction(interaction.interactionId)).toMatchObject({
      interactionId: interaction.interactionId,
      status: "resolved",
      selectedChoiceId: "tests",
    });
  });

  it("binds the current project chat directly to a selected native thread", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });

    const projectThreadService = {
      createThread: vi.fn(),
      linkThread: vi.fn(async () => ({
        threadId: "thread-native-current",
        projectId: "proj-current",
        chatId: "oc_chat_current",
        feishuThreadId: "omt_linked",
        anchorMessageId: "om_linked",
        latestMessageId: "om_linked",
        sessionName: "thread-native-current",
        title: "native follow-up",
        ownerOpenId: "ou_demo",
        status: "warm",
      })),
    };

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      projectThreadService,
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-native"
          ? {
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              threadCount: 2,
              activeThreadCount: 2,
              lastUpdatedAt: "2026-03-28T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn((threadId: string) => threadId === "thread-native-current"
          ? {
              threadId: "thread-native-current",
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              title: "native follow-up",
              source: "vscode",
              archived: false,
              updatedAt: "2026-03-28T00:00:00.000Z",
              createdAt: "2026-03-27T00:00:00.000Z",
              gitBranch: "main",
              cliVersion: "0.116.0",
              rolloutPath: "D:/rollout",
            }
          : undefined),
        listRecentConversation: vi.fn(() => [
          {
            role: "assistant",
            text: "更早的助手回复，不应展示",
            timestamp: "2026-03-27T00:00:00.000Z",
          },
          {
            role: "user",
            text: "最后一条用户消息，应该在群绑定卡里展示。",
            timestamp: "2026-03-27T00:00:01.000Z",
          },
          {
            role: "assistant",
            text: "第二条应展示的助手回复",
            timestamp: "2026-03-27T00:00:02.000Z",
          },
          {
            role: "assistant",
            text: "第三条应展示的助手回复",
            timestamp: "2026-03-27T00:00:03.000Z",
          },
          {
            role: "assistant",
            text: "第四条应展示的助手回复",
            timestamp: "2026-03-27T00:00:04.000Z",
          },
          {
            role: "assistant",
            text: "第五条应展示的助手回复",
            timestamp: "2026-03-27T00:00:05.000Z",
          },
        ]),
      },
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca thread switch thread-native-current",
    });

    expect(projectThreadService.linkThread).not.toHaveBeenCalled();
    expect(store.getCodexChatBinding("feishu", "oc_chat_current")).toMatchObject({
      channel: "feishu",
      chatId: "oc_chat_current",
      codexThreadId: "thread-native-current",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前会话已就绪");
    expect(cardText).toContain("最近上下文");
    expect(cardText).toContain("最后一条用户消息，应该在群绑定卡里展示。");
    expect(cardText).toContain("第二条应展示的助手回复");
    expect(cardText).toContain("第三条应展示的助手回复");
    expect(cardText).toContain("第四条应展示的助手回复");
    expect(cardText).toContain("第五条应展示的助手回复");
    expect(cardText).not.toContain("更早的助手回复，不应展示");
    expect(cardText).toContain("直接发送下一条消息继续当前会话");
  });

  it("resumes the same native thread on the next plain group message after switching the current project chat", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.upsertProjectChat({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      groupMessageType: "thread",
      title: "Codex | Current Project",
    });

    const runner = createRunnerDouble([
      { type: "text", content: "群聊续跑已经进入 thread-native-current" },
      { type: "done", content: "群聊续跑已经进入 thread-native-current" },
    ]);
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: {
        listProjects: vi.fn(() => []),
        getProject: vi.fn((projectKey: string) => projectKey === "proj-native"
          ? {
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              threadCount: 2,
              activeThreadCount: 2,
              lastUpdatedAt: "2026-03-28T00:00:00.000Z",
              gitBranch: "main",
            }
          : undefined),
        listThreads: vi.fn(() => []),
        getThread: vi.fn((threadId: string) => threadId === "thread-native-current"
          ? {
              threadId: "thread-native-current",
              projectKey: "proj-native",
              cwd: path.join(bridgeRootCwd, "coding-anywhere"),
              displayName: "coding-anywhere",
              title: "native follow-up",
              source: "vscode",
              archived: false,
              updatedAt: "2026-03-28T00:00:00.000Z",
              createdAt: "2026-03-27T00:00:00.000Z",
              gitBranch: "main",
              cliVersion: "0.116.0",
              rolloutPath: "D:/rollout",
            }
          : undefined),
        listRecentConversation: vi.fn(() => []),
      },
    });

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca thread switch thread-native-current",
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "继续处理当前专利线程",
    });

    expect(runner.ensureSession).toHaveBeenCalledWith({
      targetKind: "codex_thread",
      threadId: "thread-native-current",
      sessionName: "thread-native-current",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      {
        targetKind: "codex_thread",
        threadId: "thread-native-current",
        sessionName: "thread-native-current",
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      },
      expect.stringContaining("继续处理当前专利线程"),
      expect.any(Function),
    );
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "群聊续跑已经进入 thread-native-current",
      },
    ]);
  });
});

function bindGroupMainlineCodexThread(
  store: SessionStore,
  input: {
    projectId: string;
    projectName?: string;
    chatId: string;
    threadId: string;
  },
): void {
  store.upsertProjectChat({
    projectId: input.projectId,
    chatId: input.chatId,
    groupMessageType: "thread",
    title: `Codex | ${input.projectName ?? input.projectId}`,
  });
  store.bindCodexChat({
    channel: "feishu",
    chatId: input.chatId,
    codexThreadId: input.threadId,
  });
}

function createSingleThreadCatalog(input: {
  projectKey: string;
  displayName: string;
  cwd: string;
  threadId: string;
  title: string;
}) {
  const project = {
    projectKey: input.projectKey,
    cwd: input.cwd,
    displayName: input.displayName,
    threadCount: 1,
    activeThreadCount: 1,
    lastUpdatedAt: "2026-03-30T00:00:00.000Z",
    gitBranch: "main",
  };
  const thread: CodexCatalogThread = {
    threadId: input.threadId,
    projectKey: input.projectKey,
    cwd: input.cwd,
    displayName: input.displayName,
    title: input.title,
    source: "vscode",
    archived: false,
    updatedAt: "2026-03-30T00:00:00.000Z",
    createdAt: "2026-03-29T00:00:00.000Z",
    gitBranch: "main",
    cliVersion: "0.116.0",
    rolloutPath: "D:/rollout",
  };

  return {
    listProjects: vi.fn(() => [project]),
    getProject: vi.fn((projectKey: string) => projectKey === input.projectKey ? project : undefined),
    listThreads: vi.fn(() => [thread]),
    getThread: vi.fn((threadId: string) => threadId === input.threadId ? thread : undefined),
    listRecentConversation: vi.fn(() => []),
  };
}

function createRunnerDouble(
  events: RunnerEvent[] = [
    { type: "tool_call", toolName: "command_execution", content: "command_execution" },
    { type: "text", content: "测试已经执行完成" },
    { type: "done", content: "测试已经执行完成" },
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

function createGitRepo(rootDir: string, prefix: string): string {
  const repoDir = mkdtempSync(path.join(rootDir, `${prefix}-`));
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.name", "Codex Test"]);
  git(repoDir, ["config", "user.email", "codex@example.com"]);
  return repoDir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

function readCardSummaryMarkdown(card: Record<string, unknown>): string {
  const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
  const summary = body?.elements?.find(element => element.tag === "markdown");
  return typeof summary?.content === "string" ? summary.content : "";
}

function readCardAllMarkdown(card: Record<string, unknown>): string {
  const parts: string[] = [];
  collectMarkdownParts(card, parts);
  return parts.join("\n");
}

function collectMarkdownParts(node: unknown, parts: string[]): void {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectMarkdownParts(item, parts);
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  const record = node as Record<string, unknown>;
  if (record.tag === "markdown" && typeof record.content === "string") {
    parts.push(record.content);
  }

  for (const value of Object.values(record)) {
    collectMarkdownParts(value, parts);
  }
}
