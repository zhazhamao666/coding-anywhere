import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("reads recent user and assistant conversation items from a thread rollout", () => {
    const rolloutPath = path.join(rootDir, "alpha-2.jsonl");
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-03-27T10:22:18.874Z",
          type: "session_meta",
          payload: {
            id: "thread-alpha-2",
            timestamp: "2026-03-27T10:22:18.874Z",
            cwd: "D:\\Repos\\Alpha",
            cli_version: "0.116.0",
            source: "cli",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-27T10:22:30.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "先检查最近一次失败原因",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-27T10:22:45.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "我先看线程里的报错和最近的工具调用。",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-27T10:23:10.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "如果需要的话直接修复。",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-27T10:23:40.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "已经定位到问题点，接下来会补测试再改实现。",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const catalog = new CodexSqliteCatalog({
      sqlitePath,
      sessionIndexPath,
    });

    expect(catalog.listRecentConversation("thread-alpha-2", 3)).toEqual([
      {
        role: "assistant",
        text: "我先看线程里的报错和最近的工具调用。",
        timestamp: "2026-03-27T10:22:45.000Z",
      },
      {
        role: "user",
        text: "如果需要的话直接修复。",
        timestamp: "2026-03-27T10:23:10.000Z",
      },
      {
        role: "assistant",
        text: "已经定位到问题点，接下来会补测试再改实现。",
        timestamp: "2026-03-27T10:23:40.000Z",
      },
    ]);
  });

  it("supplements threads from session rollouts when session_index is ahead of the SQLite catalog", () => {
    const sessionDir = path.join(rootDir, "sessions", "2026", "03", "27");
    mkdirSync(sessionDir, { recursive: true });
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
        JSON.stringify({
          id: "thread-alpha-3",
          thread_name: "Alpha 会话索引补录",
          updated_at: "2026-03-27T10:23:32.707Z",
        }),
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(sessionDir, "rollout-2026-03-27T18-22-18-thread-alpha-3.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-03-27T10:23:31.824Z",
          type: "session_meta",
          payload: {
            id: "thread-alpha-3",
            timestamp: "2026-03-27T10:22:18.874Z",
            cwd: "D:\\Repos\\Alpha",
            cli_version: "0.115.0-alpha.27",
            source: "vscode",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const catalog = new CodexSqliteCatalog({
      sqlitePath,
      sessionIndexPath,
    });

    const project = catalog.listProjects()[0];
    const threads = catalog.listThreads(project.projectKey);

    expect(threads.map(thread => thread.threadId)).toEqual([
      "thread-alpha-3",
      "thread-alpha-2",
      "thread-alpha-1",
    ]);
    expect(threads[0]).toMatchObject({
      threadId: "thread-alpha-3",
      title: "Alpha 会话索引补录",
      cwd: "D:\\Repos\\Alpha",
      source: "vscode",
      archived: false,
      cliVersion: "0.115.0-alpha.27",
    });
    expect(catalog.getThread("thread-alpha-3")).toMatchObject({
      threadId: "thread-alpha-3",
      title: "Alpha 会话索引补录",
    });
  });
});
