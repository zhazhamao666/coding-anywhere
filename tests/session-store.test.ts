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
      source: "acpx",
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
      totalRuns: 1,
      failedRuns24h: 0,
    });
    expect(observabilityStore.listRuns({ limit: 10 })).toEqual([
      expect.objectContaining({
        runId: "run-1",
        status: "done",
        stage: "done",
        latestTool: "npm test",
      }),
    ]);
    expect(observabilityStore.getRun("run-1")).toMatchObject({
      runId: "run-1",
      peerId: "ou_demo",
      sessionName: "codex-main",
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
        source: "acpx",
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
      source: "acpx",
      status: "running",
      stage: "text",
      preview: "使用",
      coalesceSimilar: true,
    });
    observabilityStore.appendRunEvent({
      runId: "run-merge",
      source: "acpx",
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
  });
});
