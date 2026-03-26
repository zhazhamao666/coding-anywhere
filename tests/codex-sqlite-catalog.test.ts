import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexSqliteCatalog } from "../src/codex-sqlite-catalog.js";

describe("CodexSqliteCatalog", () => {
  let rootDir: string;
  let sqlitePath: string;
  let sessionIndexPath: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "codex-catalog-"));
    sqlitePath = path.join(rootDir, "state_5.sqlite");
    sessionIndexPath = path.join(rootDir, "session_index.jsonl");

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled',
        model TEXT,
        reasoning_effort TEXT,
        agent_path TEXT
      );
    `);

    const insert = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, archived, git_branch, cli_version
      ) VALUES (
        @id, @rolloutPath, @createdAt, @updatedAt, @source, 'openai', @cwd, @title,
        '{}', 'never', @archived, @gitBranch, '0.116.0'
      )
    `);

    insert.run({
      id: "thread-alpha-1",
      rolloutPath: path.join(rootDir, "alpha-1.jsonl"),
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_300,
      source: "vscode",
      cwd: "\\\\?\\D:\\Repos\\Alpha",
      title: "Alpha main task",
      archived: 0,
      gitBranch: "main",
    });
    insert.run({
      id: "thread-alpha-2",
      rolloutPath: path.join(rootDir, "alpha-2.jsonl"),
      createdAt: 1_700_000_100,
      updatedAt: 1_700_000_500,
      source: "cli",
      cwd: "d:/repos/alpha",
      title: "Alpha follow-up",
      archived: 0,
      gitBranch: "feature/x",
    });
    insert.run({
      id: "thread-beta-1",
      rolloutPath: path.join(rootDir, "beta-1.jsonl"),
      createdAt: 1_700_000_200,
      updatedAt: 1_700_000_400,
      source: "vscode",
      cwd: "D:\\Repos\\Beta",
      title: "Beta archived",
      archived: 1,
      gitBranch: "main",
    });

    db.close();

    writeFileSync(
      sessionIndexPath,
      [
        JSON.stringify({
          id: "thread-alpha-2",
          thread_name: "旧的 Alpha 名称",
          updated_at: "2026-03-25T00:00:00.000Z",
        }),
        JSON.stringify({
          id: "thread-alpha-2",
          thread_name: "Alpha 正式名称",
          updated_at: "2026-03-26T00:00:00.000Z",
        }),
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("groups threads by normalized cwd into derived projects", () => {
    const catalog = new CodexSqliteCatalog({
      sqlitePath,
      sessionIndexPath,
    });

    const projects = catalog.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      displayName: "Alpha",
      threadCount: 2,
      activeThreadCount: 2,
      gitBranch: "feature/x",
    });
  });

  it("lists project threads ordered by updated time descending", () => {
    const catalog = new CodexSqliteCatalog({
      sqlitePath,
      sessionIndexPath,
    });

    const project = catalog.listProjects()[0];
    const threads = catalog.listThreads(project.projectKey);

    expect(threads.map(thread => thread.threadId)).toEqual([
      "thread-alpha-2",
      "thread-alpha-1",
    ]);
    expect(threads[0]).toMatchObject({
      projectKey: project.projectKey,
      cwd: "D:\\Repos\\Alpha",
      title: "Alpha 正式名称",
      source: "cli",
      archived: false,
    });
  });

  it("can read archived threads when explicitly requested", () => {
    const catalog = new CodexSqliteCatalog({
      sqlitePath,
      sessionIndexPath,
    });

    const projects = catalog.listProjects({
      includeArchived: true,
    });
    const beta = projects.find(project => project.displayName === "Beta");

    expect(beta).toBeDefined();
    const threads = catalog.listThreads(beta!.projectKey, {
      includeArchived: true,
    });

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      threadId: "thread-beta-1",
      archived: true,
    });
  });

  it("prefers the latest session_index thread_name over the SQLite title", () => {
    const catalog = new CodexSqliteCatalog({
      sqlitePath,
      sessionIndexPath,
    });

    const thread = catalog.getThread("thread-alpha-2");

    expect(thread).toMatchObject({
      threadId: "thread-alpha-2",
      title: "Alpha 正式名称",
    });
  });
});
