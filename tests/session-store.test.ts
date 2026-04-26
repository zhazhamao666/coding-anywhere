import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/workspace/session-store.js";

describe("SessionStore", () => {
  let rootDir: string;
  let store: SessionStore | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-store-"));
  });

  afterEach(() => {
    store?.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("stores a single configured root and binds a DM to a persistent session", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: path.join(rootDir, "repos"),
      repoRoot: path.join(rootDir, "repos"),
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });

    store.bindThread({
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
    });

    expect(store.getRoot()).toMatchObject({
      id: "main",
      cwd: path.join(rootDir, "repos"),
    });

    expect(store.getBinding("feishu", "ou_demo")).toMatchObject({
      sessionName: "codex-main",
    });
  });

  it("persists a DM project selection independently from the current thread binding", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.setCodexProjectSelection({
      channel: "feishu",
      peerId: "ou_demo",
      projectKey: "project-alpha",
    });

    expect(store.getCodexProjectSelection("feishu", "ou_demo")).toMatchObject({
      channel: "feishu",
      peerId: "ou_demo",
      projectKey: "project-alpha",
    });

    store.clearCodexProjectSelection("feishu", "ou_demo");

    expect(store.getCodexProjectSelection("feishu", "ou_demo")).toBeUndefined();
  });

  it("tracks known DM peers for desktop notification fallback", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.recordDmPeer({
      channel: "feishu",
      peerId: "ou_demo",
      updatedAt: "2026-04-20T10:00:00.000Z",
    });

    expect(store.getUniqueDmPeer("feishu")).toBe("ou_demo");

    store.recordDmPeer({
      channel: "feishu",
      peerId: "ou_other",
      updatedAt: "2026-04-20T11:00:00.000Z",
    });

    expect(store.getUniqueDmPeer("feishu")).toBeUndefined();
  });

  it("finds the preferred DM binding for a native Codex thread", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-native-1",
    });

    expect(store.getPreferredCodexWindowBindingForThread("feishu", "thread-native-1")).toMatchObject({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-native-1",
    });
    expect(store.getPreferredCodexWindowBindingForThread("feishu", "thread-native-missing")).toBeUndefined();
  });

  it("persists surface interaction state independently from Codex preferences", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.upsertSurfaceInteractionState({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
      sessionMode: "plan_next_message",
      diagnosticsOpen: true,
    });

    expect(store.getSurfaceInteractionState({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    })).toMatchObject({
      channel: "feishu",
      peerId: "ou_demo",
      sessionMode: "plan_next_message",
      diagnosticsOpen: true,
    });

    store.deleteSurfaceInteractionState({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });

    expect(store.getSurfaceInteractionState({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    })).toBeUndefined();
  });

  it("persists run summaries and event timelines for backend observability", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: path.join(rootDir, "repos"),
      repoRoot: path.join(rootDir, "repos"),
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });
    store.bindThread({
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
    });

    const observabilityStore = store as any;
    observabilityStore.createRun({
      runId: "run-1",
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
      rootId: "main",
      status: "queued",
      stage: "received",
      latestPreview: "[ca] received",
    });
    observabilityStore.appendRunEvent({
      runId: "run-1",
      source: "bridge",
      status: "queued",
      stage: "received",
        preview: "[ca] received",
    });
    observabilityStore.appendRunEvent({
      runId: "run-1",
      source: "runner",
      status: "tool_active",
      stage: "tool_call",
      preview: "[ca] tool_call: npm test",
      toolName: "npm test",
    });
    observabilityStore.completeRun({
      runId: "run-1",
      status: "done",
      stage: "done",
      latestPreview: "任务完成",
      latestTool: "npm test",
    });

    expect(observabilityStore.getOverview()).toMatchObject({
      activeRuns: 0,
      queuedRuns: 0,
      cancelingRuns: 0,
      totalRuns: 1,
      failedRuns24h: 0,
      longestActiveMs: 0,
      longestQueuedMs: 0,
      latestCancel: null,
    });
    expect(observabilityStore.listRuns({ limit: 10 })).toEqual([
      expect.objectContaining({
        runId: "run-1",
        status: "done",
        stage: "done",
        latestTool: "npm test",
        cancelRequestedAt: null,
        cancelRequestedBy: null,
        cancelSource: null,
      }),
    ]);
    expect(observabilityStore.getRun("run-1")).toMatchObject({
      runId: "run-1",
      peerId: "ou_demo",
      sessionName: "codex-main",
      cancelRequestedAt: null,
      finishedAt: expect.any(String),
    });
    expect(observabilityStore.listRunEvents("run-1")).toEqual([
      expect.objectContaining({
        runId: "run-1",
        seq: 1,
        source: "bridge",
        stage: "received",
      }),
      expect.objectContaining({
        runId: "run-1",
        seq: 2,
        source: "runner",
        toolName: "npm test",
      }),
    ]);
    expect(observabilityStore.listSessionSnapshots()).toEqual([
      expect.objectContaining({
        channel: "feishu",
        peerId: "ou_demo",
        sessionName: "codex-main",
        latestRunId: "run-1",
        latestRunStatus: "done",
      }),
    ]);
  });

  it("coalesces consecutive text observability events instead of storing every chunk", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: path.join(rootDir, "repos"),
      repoRoot: path.join(rootDir, "repos"),
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });

    const observabilityStore = store as any;
    observabilityStore.createRun({
      runId: "run-merge",
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
      rootId: "main",
      status: "queued",
      stage: "received",
      latestPreview: "[ca] received",
    });

    observabilityStore.appendRunEvent({
      runId: "run-merge",
      source: "runner",
      status: "running",
      stage: "text",
      preview: "使用",
      coalesceSimilar: true,
    });
    observabilityStore.appendRunEvent({
      runId: "run-merge",
      source: "runner",
      status: "running",
      stage: "text",
      preview: "使用 `using-superpowers` 技能",
      coalesceSimilar: true,
    });

    expect(observabilityStore.listRunEvents("run-merge")).toEqual([
      expect.objectContaining({
        runId: "run-merge",
        seq: 1,
        stage: "text",
        preview: "使用 `using-superpowers` 技能",
      }),
    ]);
  });

  it("persists cancellation metadata and filters runs by project, thread and delivery target", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: path.join(rootDir, "repos"),
      repoRoot: path.join(rootDir, "repos"),
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });

    const observabilityStore = store as any;
    observabilityStore.createRun({
      runId: "run-cancel",
      channel: "feishu",
      peerId: "ou_demo",
      projectId: "proj-a",
      threadId: "thread-a",
      deliveryChatId: "oc_chat_a",
      deliverySurfaceType: "thread",
      deliverySurfaceRef: "omt_a",
      sessionName: "thread-a",
      rootId: "main",
      status: "running",
      stage: "text",
      latestPreview: "still working",
    });
    observabilityStore.markRunCancelRequested({
      runId: "run-cancel",
      requestedBy: "ou_demo",
      source: "feishu",
      requestedAt: "2026-04-15T10:00:00.000Z",
    });
    observabilityStore.appendRunEvent({
      runId: "run-cancel",
      source: "system",
      status: "canceling",
      stage: "canceling",
      preview: "[ca] cancel requested",
    });
    observabilityStore.completeRun({
      runId: "run-cancel",
      status: "canceled",
      stage: "canceled",
      latestPreview: "[ca] run canceled",
    });

    observabilityStore.createRun({
      runId: "run-other",
      channel: "feishu",
      peerId: "ou_other",
      projectId: "proj-b",
      threadId: "thread-b",
      deliveryChatId: "oc_chat_b",
      deliverySurfaceType: "thread",
      deliverySurfaceRef: "omt_b",
      sessionName: "thread-b",
      rootId: "main",
      status: "done",
      stage: "done",
      latestPreview: "done",
    });

    expect(observabilityStore.getRun("run-cancel")).toMatchObject({
      runId: "run-cancel",
      status: "canceled",
      cancelRequestedAt: "2026-04-15T10:00:00.000Z",
      cancelRequestedBy: "ou_demo",
      cancelSource: "feishu",
    });
    expect(observabilityStore.getOverview()).toMatchObject({
      latestCancel: expect.stringContaining("ou_demo"),
    });
    expect(observabilityStore.listRuns({
      projectId: "proj-a",
      threadId: "thread-a",
      deliveryChatId: "oc_chat_a",
      activeOnly: false,
      limit: 10,
    })).toEqual([
      expect.objectContaining({
        runId: "run-cancel",
      }),
    ]);
  });

  it("recovers non-terminal runs into a stable terminal state without reordering history", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    const observabilityStore = store as any;
    observabilityStore.createRun({
      runId: "run-stale",
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
      rootId: "main",
      status: "running",
      stage: "text",
      latestPreview: "still working",
      startedAt: "2026-04-15T09:00:00.000Z",
      updatedAt: "2026-04-15T09:10:00.000Z",
    });
    observabilityStore.createRun({
      runId: "run-fresh",
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
      rootId: "main",
      status: "done",
      stage: "done",
      latestPreview: "finished",
      startedAt: "2026-04-15T09:30:00.000Z",
      updatedAt: "2026-04-15T09:40:00.000Z",
    });

    expect(observabilityStore.recoverInterruptedRuns({
      recoveredAt: "2026-04-15T10:00:00.000Z",
    })).toBe(1);

    expect(observabilityStore.getRun("run-stale")).toMatchObject({
      runId: "run-stale",
      status: "error",
      stage: "error",
      latestPreview: "[ca] run interrupted because the service restarted",
      errorText: "[ca] run interrupted because the service restarted",
      updatedAt: "2026-04-15T09:10:00.000Z",
      finishedAt: "2026-04-15T10:00:00.000Z",
    });
    expect(observabilityStore.listRuns({ limit: 10 })).toEqual([
      expect.objectContaining({
        runId: "run-fresh",
      }),
      expect.objectContaining({
        runId: "run-stale",
        status: "error",
      }),
    ]);
  });

  it("lists historical runs by recency instead of pinning non-terminal runs first", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    const observabilityStore = store as any;
    observabilityStore.createRun({
      runId: "run-old-live",
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
      rootId: "main",
      status: "running",
      stage: "text",
      latestPreview: "still working",
      startedAt: "2026-04-15T09:00:00.000Z",
      updatedAt: "2026-04-15T09:10:00.000Z",
    });
    observabilityStore.createRun({
      runId: "run-newer-done",
      channel: "feishu",
      peerId: "ou_demo",
      sessionName: "codex-main",
      rootId: "main",
      status: "done",
      stage: "done",
      latestPreview: "finished",
      startedAt: "2026-04-15T09:30:00.000Z",
      updatedAt: "2026-04-15T09:40:00.000Z",
    });

    expect(observabilityStore.listRuns({ limit: 10 })).toEqual([
      expect.objectContaining({
        runId: "run-newer-done",
      }),
      expect.objectContaining({
        runId: "run-old-live",
      }),
    ]);
  });

  it("persists and resolves pending bridge-managed plan interactions per surface", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: path.join(rootDir, "repos"),
      repoRoot: path.join(rootDir, "repos"),
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });

    const planStore = store as any;
    const created = planStore.savePendingPlanInteraction({
      runId: "run-plan-1",
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
      threadId: "thread-plan-current",
      sessionName: "thread-plan-current",
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
    });

    expect(created).toMatchObject({
      interactionId: expect.any(String),
      runId: "run-plan-1",
      threadId: "thread-plan-current",
      status: "pending",
      choices: expect.arrayContaining([
        expect.objectContaining({
          choiceId: "architecture",
          label: "先梳理架构",
        }),
      ]),
    });

    expect(planStore.getPendingPlanInteraction(created.interactionId)).toMatchObject({
      interactionId: created.interactionId,
      question: "你希望我下一步先做哪件事？",
      status: "pending",
    });
    expect(
      planStore.getLatestPendingPlanInteractionForSurface({
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
      }),
    ).toMatchObject({
      interactionId: created.interactionId,
      threadId: "thread-plan-current",
      status: "pending",
    });

    planStore.resolvePendingPlanInteraction({
      interactionId: created.interactionId,
      selectedChoiceId: "tests",
    });

    expect(planStore.getPendingPlanInteraction(created.interactionId)).toMatchObject({
      interactionId: created.interactionId,
      status: "resolved",
      selectedChoiceId: "tests",
      resolvedAt: expect.any(String),
    });
    expect(
      planStore.getLatestPendingPlanInteractionForSurface({
        channel: "feishu",
        peerId: "ou_demo",
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
      }),
    ).toBeUndefined();
  });

  it("persists pending image assets per Feishu surface and consumes them by run", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));
    const assetStore = store as any;

    const dmAsset = assetStore.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_dm",
      chatId: null,
      surfaceType: null,
      surfaceRef: null,
      runId: null,
      messageId: "om_dm_1",
      resourceType: "image",
      resourceKey: "img_dm_1",
      localPath: path.join(rootDir, "assets", "dm-1.png"),
      fileName: "dm-1.png",
      mimeType: "image/png",
      fileSize: 1234,
      createdAt: "2026-03-28T00:00:00.000Z",
    });

    const duplicateDmAsset = assetStore.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_dm",
      chatId: null,
      surfaceType: null,
      surfaceRef: null,
      runId: null,
      messageId: "om_dm_1",
      resourceType: "image",
      resourceKey: "img_dm_1",
      localPath: path.join(rootDir, "assets", "dm-1.png"),
      fileName: "dm-1.png",
      mimeType: "image/png",
      fileSize: 1234,
      createdAt: "2026-03-28T00:02:00.000Z",
    });

    assetStore.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_dm",
      chatId: "oc_chat_1",
      surfaceType: "thread",
      surfaceRef: "omt_1",
      runId: null,
      messageId: "om_thread_1",
      resourceType: "image",
      resourceKey: "img_thread_1",
      localPath: path.join(rootDir, "assets", "thread-1.png"),
      fileName: "thread-1.png",
      mimeType: "image/png",
      fileSize: 2345,
      createdAt: "2026-03-28T00:01:00.000Z",
    });

    expect(duplicateDmAsset.assetId).toBe(dmAsset.assetId);

    expect(
      assetStore.listPendingBridgeAssetsForSurface({
        channel: "feishu",
        peerId: "ou_dm",
        chatId: null,
        surfaceType: null,
        surfaceRef: null,
      }),
    ).toEqual([
      expect.objectContaining({
        assetId: dmAsset.assetId,
        resourceKey: "img_dm_1",
        status: "pending",
      }),
    ]);

    const consumed = assetStore.consumePendingBridgeAssetsForSurface({
      runId: "run-1",
      channel: "feishu",
      peerId: "ou_dm",
      chatId: null,
      surfaceType: null,
      surfaceRef: null,
    });

    expect(consumed).toEqual([
      expect.objectContaining({
        assetId: dmAsset.assetId,
        runId: "run-1",
        status: "consumed",
      }),
    ]);

    expect(
      assetStore.listPendingBridgeAssetsForSurface({
        channel: "feishu",
        peerId: "ou_dm",
        chatId: null,
        surfaceType: null,
        surfaceRef: null,
      }),
    ).toEqual([]);

    expect(
      assetStore.listPendingBridgeAssetsForSurface({
        channel: "feishu",
        peerId: "ou_dm",
        chatId: "oc_chat_1",
        surfaceType: "thread",
        surfaceRef: "omt_1",
      }),
    ).toEqual([
      expect.objectContaining({
        resourceKey: "img_thread_1",
        status: "pending",
      }),
    ]);
  });

  it("marks pending image assets as failed and expires stale ones", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));
    const assetStore = store as any;

    const failedAsset = assetStore.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_dm",
      chatId: null,
      surfaceType: null,
      surfaceRef: null,
      runId: null,
      messageId: "om_failed",
      resourceType: "image",
      resourceKey: "img_failed",
      localPath: path.join(rootDir, "assets", "failed.png"),
      fileName: "failed.png",
      mimeType: "image/png",
      fileSize: 3456,
      createdAt: "2026-03-28T00:00:00.000Z",
    });

    const staleAsset = assetStore.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_dm",
      chatId: null,
      surfaceType: null,
      surfaceRef: null,
      runId: null,
      messageId: "om_stale",
      resourceType: "image",
      resourceKey: "img_stale",
      localPath: path.join(rootDir, "assets", "stale.png"),
      fileName: "stale.png",
      mimeType: "image/png",
      fileSize: 4567,
      createdAt: "2026-03-20T00:00:00.000Z",
    });

    expect(
      assetStore.failPendingBridgeAsset({
        assetId: failedAsset.assetId,
        errorText: "download failed",
      }),
    ).toMatchObject({
      assetId: failedAsset.assetId,
      status: "failed",
      errorText: "download failed",
    });
    expect(
      assetStore.failPendingBridgeAsset({
        assetId: failedAsset.assetId,
        errorText: "download failed again",
      }),
    ).toBeUndefined();

    expect(assetStore.expirePendingBridgeAssets("2026-03-25T00:00:00.000Z")).toBe(1);
    expect(assetStore.getBridgeAsset(staleAsset.assetId)).toMatchObject({
      assetId: staleAsset.assetId,
      status: "expired",
    });
    expect(
      assetStore.listPendingBridgeAssetsForSurface({
        channel: "feishu",
        peerId: "ou_dm",
        chatId: null,
        surfaceType: null,
        surfaceRef: null,
      }),
    ).toEqual([]);
  });

  it("migrates the legacy workspace root and drops obsolete tables", () => {
    const dbPath = path.join(rootDir, "bridge.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        branch_policy TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        env_allowlist TEXT NOT NULL,
        idle_ttl_hours INTEGER NOT NULL
      );

      INSERT INTO workspaces (
        id, name, cwd, repo_root, branch_policy, permission_mode, env_allowlist, idle_ttl_hours
      ) VALUES (
        'legacy-root',
        'Legacy Root',
        'D:/legacy',
        'D:/legacy',
        'reuse',
        'workspace-write',
        '["PATH","HOME"]',
        12
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE acp_sessions (
        session_name TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        session_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE message_links (
        run_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (run_id, message_id)
      );

      CREATE TABLE event_offsets (
        run_id TEXT PRIMARY KEY,
        line_offset INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacyDb.close();

    store = new SessionStore(dbPath);

    expect(store.getRoot()).toMatchObject({
      id: "legacy-root",
      name: "Legacy Root",
      cwd: "D:/legacy",
      repoRoot: "D:/legacy",
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH", "HOME"],
      idleTtlHours: 12,
    });

    const migratedDb = new Database(dbPath, { readonly: true });
    const tables = migratedDb.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    migratedDb.close();

    expect(tables.map(table => table.name)).not.toEqual(expect.arrayContaining([
      "workspaces",
      "users",
      "acp_sessions",
      "runs",
      "message_links",
      "event_offsets",
    ]));
    expect(tables.map(table => table.name)).toEqual(expect.arrayContaining([
      "codex_project_selections",
    ]));
  });

  it("migrates historical observability event sources from acpx to runner", () => {
    const dbPath = path.join(rootDir, "bridge.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE observability_runs (
        run_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        project_id TEXT,
        thread_id TEXT,
        delivery_chat_id TEXT,
        delivery_surface_type TEXT,
        delivery_surface_ref TEXT,
        session_name TEXT NOT NULL,
        root_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        latest_preview TEXT NOT NULL,
        latest_tool TEXT,
        error_text TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE observability_run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        preview TEXT NOT NULL,
        tool_name TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
    legacyDb.prepare(`
      INSERT INTO observability_runs (
        run_id,
        channel,
        peer_id,
        session_name,
        root_id,
        status,
        stage,
        latest_preview,
        started_at,
        updated_at
      ) VALUES (
        'run-legacy',
        'feishu',
        'ou_demo',
        'thread-demo',
        'main',
        'done',
        'done',
        'done',
        '2026-04-14T00:00:00.000Z',
        '2026-04-14T00:00:00.000Z'
      )
    `).run();
    legacyDb.prepare(`
      INSERT INTO observability_run_events (
        run_id,
        seq,
        source,
        status,
        stage,
        preview,
        tool_name,
        created_at
      ) VALUES (
        'run-legacy',
        1,
        'acpx',
        'tool_active',
        'tool_call',
        '[ca] tool_call: npm test',
        'npm test',
        '2026-04-14T00:00:00.000Z'
      )
    `).run();
    legacyDb.close();

    store = new SessionStore(dbPath);

    expect((store as any).listRunEvents("run-legacy")).toEqual([
      expect.objectContaining({
        runId: "run-legacy",
        source: "runner",
        toolName: "npm test",
      }),
    ]);
  });
});
