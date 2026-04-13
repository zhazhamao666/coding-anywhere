import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import type { AcpxEvent, CodexCatalogThread, ProgressCardState } from "../src/types.js";
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
    expect(cardText).not.toContain("计划模式");
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
    expect(cardText).toContain("计划模式");
    expect(cardText).not.toContain("DM 快捷命令");
  });

  it("shows only the thread title in the DM hub when the session id already points at the same native thread", async () => {
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
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("**当前线程**：native follow-up");
    expect(cardText).toContain("**Session**：thread-native-current");
    expect(cardText).not.toContain("**当前线程**：thread-native-current · native follow-up");
  });

  it("shows only the thread title in the registered thread hub when the session id already points at the same native thread", async () => {
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

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("**当前线程**：follow-up");
    expect(cardText).toContain("**Session**：codex-proj-current-thread-current");
    expect(cardText).not.toContain("**当前线程**：thread-current · follow-up");
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
        prompt: expect.stringContaining("Topic: 请先查看当前目录，然后运行测试"),
      },
    );
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

  it("consumes staged surface images and forwards them to the next prompt only once", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.createCodexThread({
      threadId: "thread-created",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "thread-created",
      title: "image-thread",
      ownerOpenId: "ou_demo",
      status: "warm",
    });
    store.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
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
      surfaceType: "thread",
      surfaceRef: "omt_current",
      messageId: "om_image_2",
      resourceKey: "img_dm_2",
      localPath: "D:/assets/two.png",
      fileName: "two.png",
      mimeType: "image/png",
      fileSize: 2048,
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
      surfaceType: "thread",
      surfaceRef: "omt_current",
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
        images: ["D:/assets/one.png", "D:/assets/two.png"],
      },
      expect.any(Function),
    );
    expect(runner.submitVerbatim.mock.calls[0]?.[1]).toContain("image_count: 2");
    expect(runner.submitVerbatim.mock.calls[0]?.[1]).toContain("file_name=one.png");
    expect(runner.submitVerbatim.mock.calls[0]?.[1]).toContain("source_message_id=om_image_1");
    expect(store.listPendingBridgeAssetsForSurface({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    })).toEqual([]);

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
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
    store.createCodexThread({
      threadId: "thread-created",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "thread-created",
      title: "image-thread",
      ownerOpenId: "ou_demo",
      status: "warm",
    });
    store.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
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
      surfaceType: "thread",
      surfaceRef: "omt_current",
      text: "请结合刚才的图片继续分析",
    })).rejects.toThrow("CODEX_LAUNCH_FAILED");

    expect(store.listPendingBridgeAssetsForSurface({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
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
    store.createCodexThread({
      threadId: "thread-created",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "thread-created",
      title: "image-thread",
      ownerOpenId: "ou_demo",
      status: "warm",
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
      surfaceType: "thread",
      surfaceRef: "omt_current",
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
    store.createCodexThread({
      threadId: "thread-created",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "thread-created",
      title: "image-thread",
      ownerOpenId: "ou_demo",
      status: "warm",
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
      surfaceType: "thread",
      surfaceRef: "omt_current",
      text: "请返回结果图",
    });

    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "图片已生成。",
      },
      {
        kind: "system",
        text: `[ca] image unavailable: disallowed path ${outsideImagePath}`,
      },
    ]);
  });

  it("persists bridge-managed plan interactions from runner events and exposes them on the final progress snapshot", async () => {
    store.createProject({
      projectId: "proj-current",
      name: "Current Project",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.createCodexThread({
      threadId: "thread-created",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "thread-created",
      title: "plan-thread",
      ownerOpenId: "ou_demo",
      status: "warm",
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
        surfaceType: "thread",
        surfaceRef: "omt_current",
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
        surfaceType: "thread",
        surfaceRef: "omt_current",
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
      .filter((event: { source: string; stage: string }) => event.source === "acpx" && event.stage === "text");

    expect(textEvents).toEqual([
      expect.objectContaining({
        preview: "使用 `using-superpowers` 技能",
      }),
    ]);
    expect(snapshots.filter(snapshot => snapshot.stage === "text")).toHaveLength(3);
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

  it("creates and rebinds a fresh native thread when /ca new is used inside a feishu thread", async () => {
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

    expect(runner.createThread).toHaveBeenCalledWith(
      {
        cwd: path.join(rootDir, "coding-anywhere"),
        prompt: expect.stringContaining("Topic: feishu-nav"),
      },
    );
    expect(runner.close).not.toHaveBeenCalled();
    expect(updatedThread?.threadId).toBe("thread-created");
    expect(replies).toEqual([
      {
        kind: "system",
        text: "[ca] thread reset to thread-created",
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
    const cardText = JSON.stringify((replies[0] as { card: Record<string, unknown> }).card);
    expect(cardText).toContain("Codex 项目列表");
    expect(cardText).toContain("Current Project");
    expect(cardText).toContain("已绑定当前群");
    expect(cardText).toContain("Unbound Project");
    expect(cardText).toContain("未绑定");
    expect(cardText).toContain("/ca project bind-current project-unbound");
    expect(cardText).toContain("Other Project");
    expect(cardText).toContain("已绑定其他群");
    expect(cardText).not.toContain("/ca project bind-current project-other");
    expect(cardText).not.toContain("切换项目");
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
    expect(cardText).toContain("/ca thread create-current");
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

    expect(projectThreadService.createThread).toHaveBeenCalledWith({
      projectId: "proj-a",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
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
    expect(cardText).toContain("thread-native-a");
    expect(cardText).toContain("feishu-nav");
    expect(cardText).toContain("thread-native-a");
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

    expect(projectThreadService.createThread).toHaveBeenCalledWith({
      projectId: "proj-current",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
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
    expect(cardText).toContain("thread-native-current");
    expect(cardText).toContain("follow-up");
    expect(cardText).toContain("thread-native-current");
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
    expect(cardText).toContain("线程列表");
    expect(cardText).toContain("coding-anywhere");
    expect(cardText).toContain("thread-native-current");
    expect(cardText).toContain("follow-up");
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
        title: "缺失父线程的子任务",
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
    expect(cardText).toContain("线程数：4 · 母 agent：2 · 子 agent：2");
    expect(cardText).toContain("身份：母 agent · 来源：VS Code · 分支：main");
    expect(cardText).toContain("└ 配置 social-link-ingest 运行环境");
    expect(cardText).toContain("身份：子 agent · Gauss / worker");
    expect(cardText).toContain("父线程：导入小红书优化版Karpthy知识库分享（thread-parent）");
    expect(cardText).toContain("线程 ID：thread-child · 层级：1");
    expect(cardText).toContain("身份：子 agent · Meitner / explorer");
    expect(cardText).toContain("父线程：thread-missing（不在当前列表）");
    expect(cardText).toContain("/ca thread switch thread-child");
    expect(cardText).toContain("/ca thread switch thread-orphan-child");
    expect(cardText).not.toContain("{\\\"subagent\\\"");
    expect(cardText).not.toContain("thread_spawn");

    expect(cardText.indexOf("导入小红书优化版Karpthy知识库分享")).toBeLessThan(
      cardText.indexOf("└ 配置 social-link-ingest 运行环境"),
    );
    expect(cardText.indexOf("└ 配置 social-link-ingest 运行环境")).toBeLessThan(
      cardText.indexOf("另一个母 agent 线程"),
    );
  });

  it("rebinds a registered Feishu thread to a selected native thread", async () => {
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
      threadId: "thread-native-current",
      sessionName: "thread-native-current",
      title: "native follow-up",
    });
    expect(replies).toEqual([
      {
        kind: "system",
        text: "[ca] thread switched to thread-native-current",
      },
    ]);
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
      surfaceType: "thread",
      surfaceRef: "omt_current",
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
    store.createCodexThread({
      threadId: "thread-created",
      projectId: "proj-current",
      feishuThreadId: "omt_current",
      chatId: "oc_chat_current",
      anchorMessageId: "om_current",
      latestMessageId: "om_current",
      sessionName: "thread-created",
      title: "plan-thread",
      ownerOpenId: "ou_demo",
      status: "warm",
    });

    const replies = await service.handlePlanChoice(
      {
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
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
    expect(runner.submitVerbatim.mock.calls[0]?.[1]).toContain("[user-message]");
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

  it("links a selected native thread from the project chat into a new feishu topic", async () => {
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
        listRecentConversation: vi.fn(() => []),
      },
    } as any);

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      text: "/ca thread switch thread-native-current",
    });

    expect(projectThreadService.linkThread).toHaveBeenCalledWith({
      projectId: "proj-current",
      chatId: "oc_chat_current",
      ownerOpenId: "ou_demo",
      title: "native follow-up",
      codexThreadId: "thread-native-current",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "card",
    });
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
      optionsOrOnEvent?: { images?: string[] } | ((event: AcpxEvent) => void),
      maybeOnEvent?: (event: AcpxEvent) => void,
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
