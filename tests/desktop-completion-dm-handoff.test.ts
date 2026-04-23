import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import { FeishuCardActionService } from "../src/feishu-card-action-service.js";
import type { CodexCatalogConversationItem, RunnerEvent } from "../src/types.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("desktop completion DM handoff", () => {
  const harnesses: DesktopCompletionDmHandoffHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      harness?.store.close();
      if (harness) {
        rmSync(harness.rootDir, { recursive: true, force: true });
      }
    }
  });

  it("binds the DM to the native thread and returns the standard session card for continue_desktop_thread", async () => {
    const harness = createHarness(harnesses);

    const response = await harness.cardActionService.handleAction({
      open_id: "ou_demo",
      open_message_id: "om_desktop_card_1",
      action: {
        tag: "button",
        value: {
          bridgeAction: "continue_desktop_thread",
          mode: "dm",
          threadId: "thread-alpha-2",
        },
      },
    });

    expect(harness.store.getCodexWindowBinding("feishu", "ou_demo")).toMatchObject({
      codexThreadId: "thread-alpha-2",
    });
    expect(harness.store.getCodexProjectSelection("feishu", "ou_demo")).toMatchObject({
      projectKey: "project-alpha",
    });

    const cardText = JSON.stringify(response);
    expect(cardText).toContain("当前会话已就绪");
    expect(cardText).toContain("Alpha follow-up");
    expect(cardText).toContain("最近上下文");
    expect(cardText).toContain("直接发送下一条消息继续当前线程");
    expect(cardText).toContain("下次任务设置");
    expect(cardText).not.toContain("命令已提交");
  });

  it("hides git app directives and keeps only the compact git summary in the switched-thread card", async () => {
    const harness = createHarness(harnesses);
    const repoDir = createGitRepo(harness.rootDir);
    writeFileSync(path.join(repoDir, "alpha.txt"), "alpha\n", "utf8");
    writeFileSync(path.join(repoDir, "beta.txt"), "beta\n", "utf8");
    git(repoDir, ["add", "alpha.txt", "beta.txt"]);
    git(repoDir, ["commit", "-m", "feat: add two files"]);
    const repoCwd = repoDir.replace(/\\/g, "/");

    const response = await createHandoffResponse(harness, [
      {
        role: "user",
        text: "请把这轮改动同步到飞书卡片里。",
        timestamp: "2026-04-20T10:05:00.000Z",
      },
      {
        role: "assistant",
        text: [
          "都通过了。当前分支就是 main，提交是 24e5edd，工作区干净。",
          `::git-stage{cwd=\"${repoCwd}\"}`,
          `::git-commit{cwd=\"${repoCwd}\"}`,
        ].join("\n"),
        timestamp: "2026-04-20T10:10:00.000Z",
      },
    ]);

    const cardText = JSON.stringify(response);
    expect(cardText).toContain("都通过了。当前分支就是 main，提交是 24e5edd，工作区干净。");
    expect(cardText).toContain("2 个文件已更改");
    expect(cardText).not.toContain("::git-stage");
    expect(cardText).not.toContain("::git-commit");
  });

  it("resumes the same native thread on the next plain DM message after the handoff", async () => {
    const harness = createHarness(harnesses);

    await createHandoffResponse(harness);

    const replies = await harness.bridge.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "继续处理这个桌面线程",
    });

    expect(harness.runner.ensureSession).toHaveBeenCalledWith({
      targetKind: "codex_thread",
      threadId: "thread-alpha-2",
      sessionName: "thread-alpha-2",
      cwd: "D:\\Repos\\Alpha",
    });
    expect(harness.runner.submitVerbatim).toHaveBeenCalledWith(
      {
        targetKind: "codex_thread",
        threadId: "thread-alpha-2",
        sessionName: "thread-alpha-2",
        cwd: "D:\\Repos\\Alpha",
      },
      "继续处理这个桌面线程",
      expect.any(Function),
    );
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "桌面线程已继续处理",
      },
    ]);
  });
});

async function createHandoffResponse(
  harness: DesktopCompletionDmHandoffHarness,
  recentConversation?: CodexCatalogConversationItem[],
) {
  if (recentConversation) {
    harness.codexCatalog.listRecentConversation.mockImplementation((threadId: string) =>
      threadId === "thread-alpha-2" ? recentConversation : []);
  }

  return await harness.cardActionService.handleAction({
    open_id: "ou_demo",
    open_message_id: "om_desktop_card_1",
    action: {
      tag: "button",
      value: {
        bridgeAction: "continue_desktop_thread",
        mode: "dm",
        threadId: "thread-alpha-2",
      },
    },
  });
}

function createGitRepo(rootDir: string): string {
  const repoDir = mkdtempSync(path.join(rootDir, "git-summary-"));
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

interface DesktopCompletionDmHandoffHarness {
  rootDir: string;
  store: SessionStore;
  runner: ReturnType<typeof createRunnerDouble>;
  codexCatalog: ReturnType<typeof createCatalogDouble>;
  bridge: BridgeService;
  cardActionService: FeishuCardActionService;
}

function createHarness(
  harnesses: DesktopCompletionDmHandoffHarness[],
  input?: {
    recentConversation?: CodexCatalogConversationItem[];
  },
): DesktopCompletionDmHandoffHarness {
  const rootDir = mkdtempSync(path.join(tmpdir(), "desktop-completion-dm-handoff-"));
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

  const runner = createRunnerDouble();
  const codexCatalog = createCatalogDouble(input?.recentConversation);
  const bridge = new BridgeService({
    store,
    runner,
    codexCatalog: codexCatalog as any,
  });
  const cardActionService = new FeishuCardActionService({
    bridgeService: bridge as any,
  });

  const harness = {
    rootDir,
    store,
    runner,
    codexCatalog,
    bridge,
    cardActionService,
  };
  harnesses.push(harness);
  return harness;
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

function createCatalogDouble(
  recentConversation: CodexCatalogConversationItem[] = [
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
  ],
) {
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
  return {
    listProjects: vi.fn(() => [project]),
    getProject: vi.fn((projectKey: string) => projectKey === project.projectKey ? project : undefined),
    listThreads: vi.fn((projectKey: string) => projectKey === project.projectKey ? [thread] : []),
    getThread: vi.fn((threadId: string) => threadId === thread.threadId ? thread : undefined),
    listRecentConversation: vi.fn((threadId: string) => threadId === thread.threadId ? recentConversation : []),
  };
}
