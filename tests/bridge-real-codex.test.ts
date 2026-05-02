import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

import { CodexCliRunner } from "../src/codex-cli-runner.js";
import { BridgeService } from "../src/bridge-service.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("BridgeService real runner bridge coverage", () => {
  let rootDir: string;
  let store: SessionStore;
  let bridgeRootCwd: string;

  beforeEach(() => {
    execaMock.mockReset();
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-real-codex-"));
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

  it("boots a new DM thread through the real CodexCliRunner and records the bridge run", async () => {
    execaMock
      .mockResolvedValueOnce(createGitRepoCheckSuccess(bridgeRootCwd))
      .mockImplementationOnce(() =>
        createChildFromFixture("create-thread.jsonl", 0),
      )
      .mockResolvedValueOnce(createGitRepoCheckSuccess(bridgeRootCwd))
      .mockImplementationOnce(() =>
        createChildFromFixture("resume-thread.jsonl", 0),
      );

    const runner = new CodexCliRunner("codex");
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "请先查看当前目录，然后运行测试",
    });

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({
        cwd: bridgeRootCwd,
        reject: false,
      }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "codex",
      ["exec", "--json", "-"],
      expect.objectContaining({
        cwd: bridgeRootCwd,
        input: expect.stringContaining("Session: 请先查看当前目录，然后运行测试"),
        reject: false,
      }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({
        cwd: bridgeRootCwd,
        reject: false,
      }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      4,
      "codex",
      [
        "exec",
        "resume",
        "--json",
        "019d34e0-254e-70f1-9dd5-097fb862d391",
        "-",
      ],
      expect.objectContaining({
        cwd: bridgeRootCwd,
        input: expect.stringContaining("[bridge-context]"),
        reject: false,
      }),
    );

    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "RESUMED",
      },
    ]);
    expect(store.getCodexWindowBinding("feishu", "ou_demo")).toMatchObject({
      codexThreadId: "019d34e0-254e-70f1-9dd5-097fb862d391",
    });

    const observabilityStore = store as any;
    const runs = observabilityStore.listRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      channel: "feishu",
      peerId: "ou_demo",
      projectId: null,
      threadId: "019d34e0-254e-70f1-9dd5-097fb862d391",
      sessionName: "019d34e0-254e-70f1-9dd5-097fb862d391",
      status: "done",
      stage: "done",
    });
    expect(observabilityStore.listRunEvents(runs[0].runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "received" }),
        expect.objectContaining({ stage: "tool_call" }),
        expect.objectContaining({ stage: "done" }),
      ]),
    );
  });

  it("resumes a bound DM thread through the real CodexCliRunner and keeps observability aligned", async () => {
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

    const nativeCwd = path.join(bridgeRootCwd, "coding-anywhere");
    execaMock
      .mockResolvedValueOnce(createGitRepoCheckSuccess(nativeCwd))
      .mockReturnValueOnce(
      createChildFromFixture("resume-thread.jsonl", 0),
      );

    const runner = new CodexCliRunner("codex");
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: {
        listProjects: vi.fn(() => [
          {
            projectKey: "proj-native",
            cwd: path.join(bridgeRootCwd, "coding-anywhere"),
            displayName: "coding-anywhere",
            threadCount: 1,
            activeThreadCount: 1,
            lastUpdatedAt: "2026-03-29T00:00:00.000Z",
            gitBranch: "main",
          },
        ]),
        getProject: vi.fn(() => ({
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-03-29T00:00:00.000Z",
          gitBranch: "main",
        })),
        listThreads: vi.fn(() => [
          {
            threadId: "thread-native-current",
            projectKey: "proj-native",
            cwd: path.join(bridgeRootCwd, "coding-anywhere"),
            displayName: "coding-anywhere",
            title: "follow-up",
            source: "vscode",
            archived: false,
            updatedAt: "2026-03-29T00:00:00.000Z",
            createdAt: "2026-03-28T00:00:00.000Z",
            gitBranch: "main",
            cliVersion: "0.116.0",
            rolloutPath: "D:/rollout",
          },
        ]),
        getThread: vi.fn(() => ({
          threadId: "thread-native-current",
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          title: "follow-up",
          source: "vscode",
          archived: false,
          updatedAt: "2026-03-29T00:00:00.000Z",
          createdAt: "2026-03-28T00:00:00.000Z",
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
      text: "继续对话",
    });

    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({
        cwd: nativeCwd,
        reject: false,
      }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "codex",
      ["exec", "resume", "--json", "thread-native-current", "-"],
      expect.objectContaining({
        cwd: nativeCwd,
        input: "继续对话",
        reject: false,
      }),
    );
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "RESUMED",
      },
    ]);

    const observabilityStore = store as any;
    const runs = observabilityStore.listRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      channel: "feishu",
      peerId: "ou_demo",
      projectId: "proj-native",
      threadId: "thread-native-current",
      sessionName: "thread-native-current",
      status: "done",
      stage: "done",
    });
    expect(observabilityStore.listRunEvents(runs[0].runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "received" }),
        expect.objectContaining({ stage: "tool_call" }),
        expect.objectContaining({ stage: "done" }),
      ]),
    );
  });

  it("surfaces native plan-mode waiting progress through the bridge without getting stuck", async () => {
    store.createProject({
      projectId: "proj-native",
      name: "coding-anywhere",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-plan-current",
    });

    const nativeCwd = path.join(bridgeRootCwd, "coding-anywhere");
    execaMock
      .mockResolvedValueOnce(createGitRepoCheckSuccess(nativeCwd))
      .mockReturnValueOnce(
      createChildFromFixture("plan-mode.jsonl", 0),
      );

    const runner = new CodexCliRunner("codex");
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: buildNativeCatalog({
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        projectKey: "proj-native",
        threadId: "thread-plan-current",
        title: "plan-mode",
      }),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "进入计划模式",
    });

    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({
        cwd: nativeCwd,
        reject: false,
      }),
    );
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: expect.stringContaining("`request_user_input` is unavailable"),
      },
    ]);

    const observabilityStore = store as any;
    const runs = observabilityStore.listRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      threadId: "thread-plan-current",
      sessionName: "thread-plan-current",
      status: "done",
      stage: "done",
    });
    expect(observabilityStore.listRunEvents(runs[0].runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "waiting",
          preview: "[ca] waiting: Ask whether to continue; Wait for user choice",
        }),
        expect.objectContaining({
          stage: "text",
          preview: expect.stringContaining("`request_user_input` is unavailable"),
        }),
        expect.objectContaining({
          stage: "done",
          preview: expect.stringContaining("`request_user_input` is unavailable"),
        }),
      ]),
    );
  });

  it("records native sub-agent lifecycle tool calls through the bridge and preserves the delegated final reply", async () => {
    store.createProject({
      projectId: "proj-native",
      name: "coding-anywhere",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-subagent-current",
    });

    const nativeCwd = path.join(bridgeRootCwd, "coding-anywhere");
    execaMock
      .mockResolvedValueOnce(createGitRepoCheckSuccess(nativeCwd))
      .mockReturnValueOnce(
      createChildFromFixture("sub-agent.jsonl", 0),
      );

    const runner = new CodexCliRunner("codex");
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: buildNativeCatalog({
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        projectKey: "proj-native",
        threadId: "thread-subagent-current",
        title: "sub-agent",
      }),
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "委派一个子代理",
    });

    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({
        cwd: nativeCwd,
        reject: false,
      }),
    );
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "subagent-fixture",
      },
    ]);

    const observabilityStore = store as any;
    const runs = observabilityStore.listRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      threadId: "thread-subagent-current",
      sessionName: "thread-subagent-current",
      status: "done",
      stage: "done",
    });
    const runEvents = observabilityStore.listRunEvents(runs[0].runId);
    expect(runEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "tool_call",
          toolName: "command_execution",
          preview: "Ran 1 command",
        }),
        expect.objectContaining({
          stage: "tool_call",
          toolName: "collab_tool_call",
          preview: "Ran 2 commands",
        }),
        expect.objectContaining({
          stage: "done",
          preview: "subagent-fixture",
        }),
      ]),
    );
    expect(JSON.stringify(runEvents)).not.toContain("[ca] tool_call: spawn_agent");
    expect(JSON.stringify(runEvents)).not.toContain("[ca] tool_call: wait");
  });
});

function buildNativeCatalog(input: {
  cwd: string;
  projectKey: string;
  threadId: string;
  title: string;
}) {
  const project = {
    projectKey: input.projectKey,
    cwd: input.cwd,
    displayName: "coding-anywhere",
    threadCount: 1,
    activeThreadCount: 1,
    lastUpdatedAt: "2026-03-29T00:00:00.000Z",
    gitBranch: "main",
  };
  const thread = {
    threadId: input.threadId,
    projectKey: input.projectKey,
    cwd: input.cwd,
    displayName: "coding-anywhere",
    title: input.title,
    source: "vscode",
    archived: false,
    updatedAt: "2026-03-29T00:00:00.000Z",
    createdAt: "2026-03-28T00:00:00.000Z",
    gitBranch: "main",
    cliVersion: "0.116.0",
    rolloutPath: "D:/rollout",
  };

  return {
    listProjects: vi.fn(() => [project]),
    getProject: vi.fn(() => project),
    listThreads: vi.fn(() => [thread]),
    getThread: vi.fn(() => thread),
    listRecentConversation: vi.fn(() => []),
  };
}

function createChildFromFixture(fileName: string, exitCode: number) {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "codex",
    fileName,
  );
  const lines = readFileSync(fixturePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map(line => `${line}\n`);

  return Object.assign(
    Promise.resolve({
      exitCode,
    }),
    {
      stdout: Readable.from(lines),
    },
  );
}

function createGitRepoCheckSuccess(cwd: string) {
  return {
    exitCode: 0,
    stdout: cwd,
    stderr: "",
  };
}
