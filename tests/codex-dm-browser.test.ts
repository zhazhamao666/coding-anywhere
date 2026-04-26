import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import { SessionStore } from "../src/workspace/session-store.js";
import type { RunnerEvent } from "../src/types.js";

describe("DM Codex browser", () => {
  let rootDir: string;
  let bridgeRootCwd: string;
  let store: SessionStore;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "codex-dm-browser-"));
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

  it("shows Codex projects in DM project list cards", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project list",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ kind: "card" });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("选择项目");
    expect(cardText).toContain("Alpha");
    expect(cardText).toContain("/ca project switch project-alpha");
    expect(cardText).toContain("进入项目");
  });

  it("switches the current DM project without immediately binding a thread", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    const switchReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project switch project-alpha",
    });

    expect(switchReplies).toHaveLength(1);
    expect(switchReplies[0]).toMatchObject({ kind: "card" });
    expect((store as any).getCodexWindowBinding("feishu", "ou_demo")).toBeUndefined();
    expect((store as any).getCodexProjectSelection("feishu", "ou_demo")).toMatchObject({
      projectKey: "project-alpha",
    });

    const switchCardText = JSON.stringify((switchReplies[0] as { card: Record<string, unknown> }).card);
    expect(switchCardText).toContain("当前项目已切换");
    expect(switchCardText).toContain("Alpha");
    expect(switchCardText).toContain("下一条普通消息会在该项目下创建新会话");
  });

  it("clears an existing DM thread binding when switching to another project", async () => {
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-alpha-2",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project switch project-beta",
    });

    expect((store as any).getCodexWindowBinding("feishu", "ou_demo")).toBeUndefined();
    expect((store as any).getCodexProjectSelection("feishu", "ou_demo")).toMatchObject({
      projectKey: "project-beta",
    });

    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前项目已切换");
    expect(cardText).toContain("Beta");
    expect(cardText).toContain("已退出之前绑定的线程");
    expect(cardText).not.toContain("Alpha follow-up");
  });

  it("treats a mismatched DM project selection as authoritative and clears the stale thread binding", async () => {
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-alpha-2",
    });
    store.setCodexProjectSelection({
      channel: "feishu",
      peerId: "ou_demo",
      projectKey: "project-beta",
    });

    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project current",
    });

    expect((store as any).getCodexWindowBinding("feishu", "ou_demo")).toBeUndefined();
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前项目");
    expect(cardText).toContain("Beta");
    expect(cardText).toContain("当前线程");
    expect(cardText).toContain("未选择");
    expect(cardText).not.toContain("Alpha follow-up");
  });

  it("uses the selected DM project for current project and current thread list when no thread is bound", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project switch project-alpha",
    });

    const projectReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project current",
    });
    const projectCardText = JSON.stringify((projectReplies[0] as { card: Record<string, unknown> }).card);
    expect(projectCardText).toContain("当前项目");
    expect(projectCardText).toContain("Alpha");
    expect(projectCardText).toContain("当前线程");
    expect(projectCardText).toContain("未选择");

    const threadReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca thread list-current",
    });
    const threadCardText = JSON.stringify((threadReplies[0] as { card: Record<string, unknown> }).card);
    expect(threadCardText).toContain("选择线程");
    expect(threadCardText).toContain("Alpha follow-up");
    expect(threadCardText).toContain("thread-alpha-1");
  });

  it("returns a project-scoped entry card from /ca after a DM project is selected but before a thread is bound", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project switch project-alpha",
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ kind: "card" });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前项目已选择");
    expect(cardText).toContain("Alpha");
    expect(cardText).toContain("未选择");
    expect(cardText).toContain("查看项目");
    expect(cardText).toContain("切换线程");
    expect(cardText).toContain("新会话");
    expect(cardText).not.toContain("当前会话已就绪");
    expect(cardText).not.toContain("计划模式");
    expect(cardText).not.toContain("下次任务设置");
  });

  it("creates the next fresh DM thread under the selected project path", async () => {
    const runner = createRunnerDouble([
      { type: "text", content: "已经在选中的项目下开始处理" },
      { type: "done", content: "已经在选中的项目下开始处理" },
    ]);
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: createCatalogDouble(),
    } as any);

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca project switch project-alpha",
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "在这个项目里开始一个新任务",
    });

    expect(runner.createThread).toHaveBeenCalledWith({
      cwd: "D:\\Repos\\Alpha",
      prompt: expect.stringContaining("在这个项目里开始一个新任务"),
    });
    expect((store as any).getCodexWindowBinding("feishu", "ou_demo")).toMatchObject({
      codexThreadId: "thread-created-1",
    });
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "已经在选中的项目下开始处理",
      },
    ]);
  });

  it("switches the current DM window to a Codex thread and routes prompts there", async () => {
    const runner = createRunnerDouble([
      { type: "text", content: "继续处理中" },
      { type: "done", content: "继续处理中" },
    ]);
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: createCatalogDouble(),
    } as any);

    const switchReplies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca thread switch thread-alpha-2",
    });

    expect(switchReplies).toHaveLength(1);
    expect(switchReplies[0]).toMatchObject({ kind: "card" });
    const switchCardText = JSON.stringify((switchReplies[0] as { card: Record<string, unknown> }).card);
    expect(switchCardText).toContain("当前会话已就绪");
    expect(switchCardText).toContain("Alpha follow-up");
    expect(switchCardText).toContain("最近上下文");
    expect(switchCardText).not.toContain("thread-alpha-2");
    expect(switchCardText).toContain("最后一条用户消息，包含完整的长文本，不应该被截断。最后一条用户消息，包含完整的长文本，不应该被截断。最后一条用户消息，包含完整的长文本，不应该被截断。");
    expect(switchCardText).toContain("第二条应展示的助手回复");
    expect(switchCardText).toContain("第三条应展示的助手回复");
    expect(switchCardText).toContain("第四条应展示的助手回复");
    expect(switchCardText).toContain("第五条应展示的助手回复");
    expect(switchCardText).not.toContain("更早的用户消息，不应展示");
    expect(switchCardText).not.toContain("第一条应展示的助手回复");
    expect((store as any).getCodexWindowBinding("feishu", "ou_demo")).toMatchObject({
      codexThreadId: "thread-alpha-2",
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "继续处理这个线程",
    });

    expect(runner.ensureSession).toHaveBeenCalledWith({
      targetKind: "codex_thread",
      threadId: "thread-alpha-2",
      sessionName: "thread-alpha-2",
      cwd: "D:\\Repos\\Alpha",
    });
    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      {
        targetKind: "codex_thread",
        threadId: "thread-alpha-2",
        sessionName: "thread-alpha-2",
        cwd: "D:\\Repos\\Alpha",
      },
      "继续处理这个线程",
      expect.any(Function),
    );
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "继续处理中",
      },
    ]);
  });

  it("shows current thread project threads in DM after a switch", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca thread switch thread-alpha-2",
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca thread list-current",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ kind: "card" });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("选择线程");
    expect(cardText).toContain("Alpha follow-up");
    expect(cardText).toContain("thread-alpha-1");
    expect(cardText).toContain("/ca thread switch thread-alpha-1");
  });

  it("shows a session card with recent messages for the current Codex thread in DM", async () => {
    const service = new BridgeService({
      store,
      runner: createRunnerDouble(),
      codexCatalog: createCatalogDouble(),
    } as any);

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca thread switch thread-alpha-2",
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "/ca session",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ kind: "card" });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("当前会话已就绪");
    expect(cardText).not.toContain("thread-alpha-2");
    expect(cardText).toContain("Alpha follow-up");
    expect(cardText).toContain("最近上下文");
    expect(cardText).toContain("最后一条用户消息，包含完整的长文本，不应该被截断。最后一条用户消息，包含完整的长文本，不应该被截断。最后一条用户消息，包含完整的长文本，不应该被截断。");
    expect(cardText).toContain("第二条应展示的助手回复");
    expect(cardText).toContain("第三条应展示的助手回复");
    expect(cardText).toContain("第四条应展示的助手回复");
    expect(cardText).toContain("第五条应展示的助手回复");
    expect(cardText).not.toContain("更早的用户消息，不应展示");
    expect(cardText).not.toContain("第一条应展示的助手回复");
  });
});

function createCatalogDouble() {
  const projects = [
    {
      projectKey: "project-alpha",
      cwd: "D:\\Repos\\Alpha",
      displayName: "Alpha",
      threadCount: 2,
      activeThreadCount: 2,
      lastUpdatedAt: "2026-03-26T01:00:00.000Z",
      gitBranch: "main",
    },
    {
      projectKey: "project-beta",
      cwd: "D:\\Repos\\Beta",
      displayName: "Beta",
      threadCount: 1,
      activeThreadCount: 1,
      lastUpdatedAt: "2026-03-26T03:00:00.000Z",
      gitBranch: "main",
    },
  ];

  const threads = [
    {
      threadId: "thread-alpha-2",
      projectKey: "project-alpha",
      cwd: "D:\\Repos\\Alpha",
      displayName: "Alpha",
      title: "Alpha follow-up",
      source: "cli",
      archived: false,
      updatedAt: "2026-03-26T02:00:00.000Z",
      createdAt: "2026-03-26T00:00:00.000Z",
      gitBranch: "feature/x",
      cliVersion: "0.116.0",
      rolloutPath: "D:\\rollouts\\alpha-2.jsonl",
    },
    {
      threadId: "thread-alpha-1",
      projectKey: "project-alpha",
      cwd: "D:\\Repos\\Alpha",
      displayName: "Alpha",
      title: "Alpha main task",
      source: "vscode",
      archived: false,
      updatedAt: "2026-03-26T01:00:00.000Z",
      createdAt: "2026-03-25T23:00:00.000Z",
      gitBranch: "main",
      cliVersion: "0.116.0",
      rolloutPath: "D:\\rollouts\\alpha-1.jsonl",
    },
    {
      threadId: "thread-beta-1",
      projectKey: "project-beta",
      cwd: "D:\\Repos\\Beta",
      displayName: "Beta",
      title: "Beta kickoff",
      source: "cli",
      archived: false,
      updatedAt: "2026-03-26T03:00:00.000Z",
      createdAt: "2026-03-26T02:30:00.000Z",
      gitBranch: "main",
      cliVersion: "0.116.0",
      rolloutPath: "D:\\rollouts\\beta-1.jsonl",
    },
  ];

  return {
    listProjects: vi.fn(() => projects),
    getProject: vi.fn((projectKey: string) => projects.find(project => project.projectKey === projectKey)),
    listThreads: vi.fn((projectKey: string) => threads.filter(thread => thread.projectKey === projectKey)),
    getThread: vi.fn((threadId: string) => threads.find(thread => thread.threadId === threadId)),
    listRecentConversation: vi.fn((threadId: string, limit?: number) => {
      const conversations: Record<string, Array<{ role: "user" | "assistant"; text: string; timestamp: string }>> = {
        "thread-alpha-2": [
          {
            role: "user",
            text: "更早的用户消息，不应展示",
            timestamp: "2026-03-26T01:55:00.000Z",
          },
          {
            role: "assistant",
            text: "更早的助手回复，不应展示",
            timestamp: "2026-03-26T01:56:00.000Z",
          },
          {
            role: "assistant",
            text: "第一条应展示的助手回复",
            timestamp: "2026-03-26T01:57:00.000Z",
          },
          {
            role: "assistant",
            text: "第二条应展示的助手回复",
            timestamp: "2026-03-26T01:58:00.000Z",
          },
          {
            role: "user",
            text: "最后一条用户消息，包含完整的长文本，不应该被截断。最后一条用户消息，包含完整的长文本，不应该被截断。最后一条用户消息，包含完整的长文本，不应该被截断。",
            timestamp: "2026-03-26T01:59:00.000Z",
          },
          {
            role: "assistant",
            text: "第三条应展示的助手回复",
            timestamp: "2026-03-26T02:00:00.000Z",
          },
          {
            role: "assistant",
            text: "第四条应展示的助手回复",
            timestamp: "2026-03-26T02:01:00.000Z",
          },
          {
            role: "assistant",
            text: "第五条应展示的助手回复",
            timestamp: "2026-03-26T02:02:00.000Z",
          },
        ],
      };

      const items = conversations[threadId] ?? [];
      return typeof limit === "number" ? items.slice(-limit) : items;
    }),
  };
}

function createRunnerDouble(
  events: RunnerEvent[] = [
    { type: "text", content: "测试已经执行完成" },
    { type: "done", content: "测试已经执行完成" },
  ],
) {
  return {
    createThread: vi.fn(async () => ({
      threadId: "thread-created-1",
      exitCode: 0,
      events: [],
    })),
    ensureSession: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    submitVerbatim: vi.fn(async (_context, _prompt, onEvent?: (event: RunnerEvent) => void) => {
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
