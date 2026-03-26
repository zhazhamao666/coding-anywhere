import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import type { AcpxEvent, ProgressCardState } from "../src/types.js";
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

  it("returns status for the current CA session without exposing projects", async () => {
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

    expect(replies).toEqual([
      {
        kind: "system",
        text: "[ca] root=main session=codex-main status=idle",
      },
    ]);
  });

  it("returns a hub card for the current project chat with button actions instead of command text", async () => {
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
    expect(cardText).toContain("\"tag\":\"button\"");
    expect(cardText).toContain("当前项目");
    expect(cardText).toContain("当前项目");
    expect(cardText).toContain("proj-current");
    expect(cardText).toContain("当前项目线程");
    expect(cardText).toContain("thread-current");
    expect(cardText).toContain("follow-up");
    expect(cardText).not.toContain("当前项目群快捷命令");
    expect(cardText).toContain("导航");
    expect(cardText).toContain("当前项目");
    expect(cardText).toContain("线程列表");
  });

  it("returns a hub card with project summaries in DM", async () => {
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
    expect(cardText).toContain("项目概览");
    expect(cardText).toContain("proj-alpha");
    expect(cardText).toContain("proj-beta");
    expect(cardText).toContain("chat=oc_chat_alpha");
    expect(cardText).not.toContain("当前项目");
    expect(cardText).toContain("项目列表");
    expect(cardText).toContain("会话状态");
    expect(cardText).toContain("当前会话");
    expect(cardText).toContain("新会话");
    expect(cardText).not.toContain("DM 快捷命令");
  });

  it("auto-binds the default root session, wraps prompts and emits lifecycle snapshots", async () => {
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

    expect(runner.ensureSession).toHaveBeenCalledWith({
      sessionName: "codex-main",
      cwd: bridgeRootCwd,
    });
    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      {
        sessionName: "codex-main",
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
      sessionName: "codex-main",
    });
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "测试已经执行完成",
      },
    ]);

    const observabilityStore = store as any;
    expect(observabilityStore.listRuns({ limit: 10 })).toEqual([
      expect.objectContaining({
        channel: "feishu",
        peerId: "ou_demo",
        sessionName: "codex-main",
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
          source: "acpx",
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
          latestTool: "npm test",
          preview: "[ca] tool_call: npm test",
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

  it("returns a hub card for CA help and unknown subcommands", async () => {
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
    expect(cardText).toContain("CA Hub");
    expect(cardText).toContain("\"command\":\"/ca\"");
    expect(cardText).toContain("会话状态");
    expect(cardText).not.toContain("DM 快捷命令");
  });

  it("resets the stored thread session when /ca new is used inside a feishu thread", async () => {
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

    expect(runner.close).toHaveBeenCalledWith({
      sessionName: "codex-proj-a-thread-a",
      cwd: path.join(rootDir, "coding-anywhere"),
    });
    expect(updatedThread?.sessionName).not.toBe("codex-proj-a-thread-a");
    expect(replies).toEqual([
      {
        kind: "system",
        text: `[ca] session reset to ${updatedThread?.sessionName}`,
      },
    ]);
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

  it("creates a thread in the bound project chat from a CA command", async () => {
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
        threadId: "thread-a",
        projectId: "proj-a",
        chatId: "oc_chat_1",
        feishuThreadId: "omt_1",
        anchorMessageId: "om_anchor",
        latestMessageId: "om_anchor",
        sessionName: "codex-proj-a-thread-a",
        title: "feishu-nav",
        ownerOpenId: "ou_demo",
        status: "provisioned",
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

    expect(projectThreadService.createThread).toHaveBeenCalledWith({
      projectId: "proj-a",
      chatId: "oc_chat_1",
      ownerOpenId: "ou_demo",
      title: "feishu-nav",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("线程已创建");
    expect(cardText).toContain("thread-a");
    expect(cardText).toContain("feishu-nav");
    expect(cardText).toContain("codex-proj-a-thread-a");
  });

  it("creates a thread from the current bound project chat without requiring a project id", async () => {
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
        threadId: "thread-current",
        projectId: "proj-current",
        chatId: "oc_chat_current",
        feishuThreadId: "omt_current",
        anchorMessageId: "om_current",
        latestMessageId: "om_current",
        sessionName: "codex-proj-current-thread-current",
        title: "follow-up",
        ownerOpenId: "ou_demo",
        status: "provisioned",
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

    expect(projectThreadService.createThread).toHaveBeenCalledWith({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      ownerOpenId: "ou_demo",
      title: "follow-up",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("线程已创建");
    expect(cardText).toContain("thread-current");
    expect(cardText).toContain("follow-up");
    expect(cardText).toContain("codex-proj-current-thread-current");
  });

  it("lists threads for the current bound project chat without requiring a project id", async () => {
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
      text: "/ca thread list-current",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("线程列表");
    expect(cardText).toContain("proj-current");
    expect(cardText).toContain("thread-current");
    expect(cardText).toContain("follow-up");
  });
});

function createRunnerDouble(
  events: AcpxEvent[] = [
    { type: "tool_call", toolName: "npm test", content: "npm test" },
    { type: "text", content: "测试已经执行完成" },
    { type: "done", content: "测试已经执行完成" },
  ],
) {
  return {
    ensureSession: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    submitVerbatim: vi.fn(async (_context, _prompt, onEvent?: (event: AcpxEvent) => void) => {
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
