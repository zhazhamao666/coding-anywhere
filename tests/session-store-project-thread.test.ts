import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/workspace/session-store.js";

describe("SessionStore project thread persistence", () => {
  let rootDir: string;
  let store: SessionStore | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-project-thread-"));
  });

  afterEach(() => {
    store?.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("creates and reloads a codex thread binding", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    const projectStore = store as any;
    projectStore.createProject({
      projectId: "proj-a",
      name: "coding-anywhere",
      cwd: "D:/repo",
      repoRoot: "D:/repo",
    });
    projectStore.upsertProjectChat({
      projectId: "proj-a",
      chatId: "oc_chat_1",
      groupMessageType: "thread",
      title: "Codex | coding-anywhere",
    });
    projectStore.createCodexThread({
      threadId: "thread-a",
      projectId: "proj-a",
      feishuThreadId: "omt_1",
      chatId: "oc_chat_1",
      anchorMessageId: "om_anchor",
      latestMessageId: "om_anchor",
      sessionName: "codex-proj-a-thread-a",
      title: "feishu-nav",
      ownerOpenId: "ou_user",
    });

    expect(projectStore.getCodexThreadBySurface("oc_chat_1", "omt_1")).toMatchObject({
      threadId: "thread-a",
      projectId: "proj-a",
      sessionName: "codex-proj-a-thread-a",
      anchorMessageId: "om_anchor",
    });
  });

  it("allows multiple Feishu surfaces to point at the same native Codex thread", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    const projectStore = store as any;
    projectStore.createProject({
      projectId: "proj-a",
      name: "coding-anywhere",
      cwd: "D:/repo",
      repoRoot: "D:/repo",
    });
    projectStore.createCodexThread({
      threadId: "thread-native-1",
      projectId: "proj-a",
      feishuThreadId: "omt_1",
      chatId: "oc_chat_1",
      anchorMessageId: "om_anchor_1",
      latestMessageId: "om_anchor_1",
      sessionName: "thread-native-1",
      title: "surface-one",
      ownerOpenId: "ou_user",
    });
    projectStore.createCodexThread({
      threadId: "thread-native-1",
      projectId: "proj-a",
      feishuThreadId: "omt_2",
      chatId: "oc_chat_1",
      anchorMessageId: "om_anchor_2",
      latestMessageId: "om_anchor_2",
      sessionName: "thread-native-1",
      title: "surface-two",
      ownerOpenId: "ou_user",
    });

    expect(projectStore.getCodexThreadBySurface("oc_chat_1", "omt_1")).toMatchObject({
      threadId: "thread-native-1",
      title: "surface-one",
    });
    expect(projectStore.getCodexThreadBySurface("oc_chat_1", "omt_2")).toMatchObject({
      threadId: "thread-native-1",
      title: "surface-two",
    });
    expect(projectStore.listProjectThreads("proj-a")).toHaveLength(2);
    expect(projectStore.listProjects()).toEqual([
      expect.objectContaining({
        projectId: "proj-a",
        threadCount: 1,
      }),
    ]);
  });

  it("migrates legacy codex_threads rows off thread_id primary-key semantics", () => {
    const dbPath = path.join(rootDir, "bridge.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO projects (
        project_id, name, cwd, repo_root, created_at, updated_at
      ) VALUES (
        'proj-a',
        'coding-anywhere',
        'D:/repo',
        'D:/repo',
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z'
      );

      CREATE TABLE codex_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        feishu_thread_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        anchor_message_id TEXT NOT NULL,
        latest_message_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        title TEXT NOT NULL,
        owner_open_id TEXT NOT NULL,
        status TEXT NOT NULL,
        last_run_id TEXT,
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE(chat_id, feishu_thread_id)
      );

      INSERT INTO codex_threads (
        thread_id,
        project_id,
        feishu_thread_id,
        chat_id,
        anchor_message_id,
        latest_message_id,
        session_name,
        title,
        owner_open_id,
        status,
        last_run_id,
        last_activity_at,
        created_at,
        updated_at,
        archived_at
      ) VALUES (
        'thread-native-1',
        'proj-a',
        'omt_legacy',
        'oc_chat_1',
        'om_anchor_legacy',
        'om_anchor_legacy',
        'thread-native-1',
        'legacy-surface',
        'ou_user',
        'warm',
        NULL,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
        NULL
      );
    `);
    legacyDb.close();

    store = new SessionStore(dbPath);
    const projectStore = store as any;
    projectStore.createCodexThread({
      threadId: "thread-native-1",
      projectId: "proj-a",
      feishuThreadId: "omt_new",
      chatId: "oc_chat_1",
      anchorMessageId: "om_anchor_new",
      latestMessageId: "om_anchor_new",
      sessionName: "thread-native-1",
      title: "new-surface",
      ownerOpenId: "ou_user",
    });

    expect(projectStore.getCodexThreadBySurface("oc_chat_1", "omt_legacy")).toMatchObject({
      threadId: "thread-native-1",
      title: "legacy-surface",
    });
    expect(projectStore.getCodexThreadBySurface("oc_chat_1", "omt_new")).toMatchObject({
      threadId: "thread-native-1",
      title: "new-surface",
    });
  });
});
