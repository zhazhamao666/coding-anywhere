import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { CodexCatalogProject, CodexCatalogThread } from "./types.js";

interface CodexThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  cwd: string;
  title: string;
  archived: number;
  git_branch: string | null;
  cli_version: string;
}

export class CodexSqliteCatalog {
  private readonly sqlitePath: string;
  private readonly sessionIndexPath: string | undefined;
  private readonly sessionsRootDir: string | undefined;

  public constructor(input?: {
    sqlitePath?: string;
    codexHomeDir?: string;
    sessionIndexPath?: string;
  }) {
    const sqlitePath = input?.sqlitePath ?? resolveDefaultCodexStateSqlitePath(input?.codexHomeDir);
    if (!sqlitePath) {
      throw new Error("CODEX_STATE_DB_NOT_FOUND");
    }
    this.sqlitePath = sqlitePath;
    this.sessionIndexPath =
      input?.sessionIndexPath ??
      path.join(path.dirname(this.sqlitePath), "session_index.jsonl");
    this.sessionsRootDir = path.join(
      path.dirname(this.sessionIndexPath ?? this.sqlitePath),
      "sessions",
    );
  }

  public listProjects(options?: { includeArchived?: boolean }): CodexCatalogProject[] {
    const threads = this.readThreads(options);
    const byProject = new Map<string, {
      cwd: string;
      displayName: string;
      threadCount: number;
      activeThreadCount: number;
      lastUpdatedAt: string;
      gitBranch: string | null;
    }>();

    for (const thread of threads) {
      const existing = byProject.get(thread.projectKey);
      if (!existing) {
        byProject.set(thread.projectKey, {
          cwd: thread.cwd,
          displayName: thread.displayName,
          threadCount: 1,
          activeThreadCount: thread.archived ? 0 : 1,
          lastUpdatedAt: thread.updatedAt,
          gitBranch: thread.gitBranch,
        });
        continue;
      }

      existing.threadCount += 1;
      if (!thread.archived) {
        existing.activeThreadCount += 1;
      }
      existing.cwd = preferDisplayCwd(existing.cwd, thread.cwd);
      existing.displayName = path.basename(existing.cwd) || existing.cwd;
      if (thread.updatedAt > existing.lastUpdatedAt) {
        existing.lastUpdatedAt = thread.updatedAt;
        existing.gitBranch = thread.gitBranch ?? existing.gitBranch;
      }
      if (!existing.gitBranch && thread.gitBranch) {
        existing.gitBranch = thread.gitBranch;
      }
    }

    return [...byProject.entries()]
      .map(([projectKey, project]) => ({
        projectKey,
        cwd: project.cwd,
        displayName: project.displayName,
        threadCount: project.threadCount,
        activeThreadCount: project.activeThreadCount,
        lastUpdatedAt: project.lastUpdatedAt,
        gitBranch: project.gitBranch,
      }))
      .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
  }

  public getProject(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogProject | undefined {
    return this.listProjects(options).find(project => project.projectKey === projectKey);
  }

  public listThreads(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogThread[] {
    const project = this.getProject(projectKey, { includeArchived: true });

    return this.readThreads(options)
      .filter(thread => thread.projectKey === projectKey)
      .map(thread => ({
        ...thread,
        cwd: project?.cwd ?? thread.cwd,
        displayName: project?.displayName ?? thread.displayName,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public getThread(threadId: string): CodexCatalogThread | undefined {
    const sessionIndex = this.readSessionIndexEntries();
    const db = this.openDb();
    try {
      const row = db.prepare(`
        SELECT
          id,
          rollout_path,
          created_at,
          updated_at,
          source,
          cwd,
          title,
          archived,
          git_branch,
          cli_version
        FROM threads
        WHERE id = ?
      `).get(threadId) as CodexThreadRow | undefined;

      if (row) {
        return mapThreadRow(row, sessionIndex);
      }

      const sessionEntry = sessionIndex.get(threadId);
      return sessionEntry ? this.readSupplementalThread(threadId, sessionEntry) : undefined;
    } finally {
      db.close();
    }
  }

  private readThreads(options?: { includeArchived?: boolean }): CodexCatalogThread[] {
    const sessionIndex = this.readSessionIndexEntries();
    const db = this.openDb();
    try {
      const rows = db.prepare(`
        SELECT
          id,
          rollout_path,
          created_at,
          updated_at,
          source,
          cwd,
          title,
          archived,
          git_branch,
          cli_version
        FROM threads
        ORDER BY updated_at DESC
      `).all() as CodexThreadRow[];

      const threads = rows.map(row => mapThreadRow(row, sessionIndex));
      const knownThreadIds = new Set(rows.map(row => row.id));

      threads.push(...this.readSupplementalThreads(knownThreadIds, sessionIndex));

      return threads
        .filter(thread => options?.includeArchived ? true : !thread.archived);
    } finally {
      db.close();
    }
  }

  private readSessionIndexEntries(): Map<string, SessionIndexEntry> {
    const threadNames = new Map<string, SessionIndexEntry>();
    if (!this.sessionIndexPath || !existsSync(this.sessionIndexPath)) {
      return new Map();
    }

    const content = readFileSync(this.sessionIndexPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (typeof parsed?.id !== "string" || typeof parsed?.thread_name !== "string") {
        continue;
      }

      const updatedAt = typeof parsed?.updated_at === "string" ? parsed.updated_at : "";
      const existing = threadNames.get(parsed.id);
      if (!existing || updatedAt >= existing.updatedAt) {
        threadNames.set(parsed.id, {
          updatedAt,
          threadName: parsed.thread_name,
        });
      }
    }

    return threadNames;
  }

  private readSupplementalThreads(
    knownThreadIds: Set<string>,
    sessionIndex: Map<string, SessionIndexEntry>,
  ): CodexCatalogThread[] {
    const missingThreadIds = [...sessionIndex.keys()].filter(threadId => !knownThreadIds.has(threadId));
    if (missingThreadIds.length === 0) {
      return [];
    }

    const rolloutPaths = this.findRolloutPathsByThreadId(new Set(missingThreadIds));
    const threads: CodexCatalogThread[] = [];
    for (const threadId of missingThreadIds) {
      const sessionEntry = sessionIndex.get(threadId);
      if (!sessionEntry) {
        continue;
      }

      const rolloutPath = rolloutPaths.get(threadId);
      if (!rolloutPath) {
        continue;
      }

      const thread = this.readSupplementalThread(threadId, sessionEntry, rolloutPath);
      if (thread) {
        threads.push(thread);
      }
    }

    return threads;
  }

  private readSupplementalThread(
    threadId: string,
    sessionEntry: SessionIndexEntry,
    rolloutPath?: string,
  ): CodexCatalogThread | undefined {
    const resolvedRolloutPath = rolloutPath ?? this.findRolloutPathsByThreadId(new Set([threadId])).get(threadId);
    if (!resolvedRolloutPath) {
      return undefined;
    }

    const sessionMeta = readSessionMeta(resolvedRolloutPath, threadId);
    if (!sessionMeta) {
      return undefined;
    }

    const cwd = normalizeCodexCwd(sessionMeta.cwd);
    return {
      threadId,
      projectKey: encodeProjectKey(cwd),
      cwd,
      displayName: path.basename(cwd) || cwd,
      title: sessionEntry.threadName,
      source: sessionMeta.source,
      archived: false,
      updatedAt: sessionEntry.updatedAt,
      createdAt: sessionMeta.createdAt,
      gitBranch: null,
      cliVersion: sessionMeta.cliVersion,
      rolloutPath: resolvedRolloutPath,
    };
  }

  private findRolloutPathsByThreadId(threadIds: Set<string>): Map<string, string> {
    const matches = new Map<string, string>();
    if (!this.sessionsRootDir || !existsSync(this.sessionsRootDir) || threadIds.size === 0) {
      return matches;
    }

    const pendingIds = new Set(threadIds);
    const queue = [this.sessionsRootDir];

    while (queue.length > 0 && pendingIds.size > 0) {
      const currentDir = queue.pop();
      if (!currentDir) {
        continue;
      }

      for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }

        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }

        for (const threadId of pendingIds) {
          if (!entry.name.includes(threadId)) {
            continue;
          }
          matches.set(threadId, fullPath);
          pendingIds.delete(threadId);
          break;
        }
      }
    }

    return matches;
  }

  private openDb(): Database.Database {
    return new Database(this.sqlitePath, {
      readonly: true,
      fileMustExist: true,
    });
  }
}

export function resolveDefaultCodexStateSqlitePath(codexHomeDir = path.join(homedir(), ".codex")): string | undefined {
  if (!existsSync(codexHomeDir)) {
    return undefined;
  }

  const candidates = readdirSync(codexHomeDir)
    .filter(name => /^state(?:_\d+)?\.sqlite$/i.test(name))
    .sort((left, right) => extractStateVersion(right) - extractStateVersion(left));

  if (candidates.length === 0) {
    return undefined;
  }

  return path.join(codexHomeDir, candidates[0]);
}

function mapThreadRow(row: CodexThreadRow, sessionIndex: Map<string, SessionIndexEntry>): CodexCatalogThread {
  const cwd = normalizeCodexCwd(row.cwd);
  const resolvedTitle = sessionIndex.get(row.id)?.threadName ?? row.title;

  return {
    threadId: row.id,
    projectKey: encodeProjectKey(cwd),
    cwd,
    displayName: path.basename(cwd) || cwd,
    title: resolvedTitle,
    source: row.source,
    archived: row.archived === 1,
    updatedAt: epochToIso(row.updated_at),
    createdAt: epochToIso(row.created_at),
    gitBranch: row.git_branch,
    cliVersion: row.cli_version,
    rolloutPath: row.rollout_path,
  };
}

function readSessionMeta(filePath: string, threadId: string): SessionMeta | undefined {
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed?.type !== "session_meta" || parsed?.payload?.id !== threadId) {
      continue;
    }

    if (typeof parsed?.payload?.cwd !== "string") {
      return undefined;
    }

    const createdAt = typeof parsed?.payload?.timestamp === "string"
      ? parsed.payload.timestamp
      : typeof parsed?.timestamp === "string"
        ? parsed.timestamp
        : new Date(0).toISOString();

    return {
      cwd: parsed.payload.cwd,
      source: typeof parsed?.payload?.source === "string" ? parsed.payload.source : "unknown",
      cliVersion: typeof parsed?.payload?.cli_version === "string" ? parsed.payload.cli_version : "",
      createdAt,
    };
  }

  return undefined;
}

function normalizeCodexCwd(raw: string): string {
  const withoutPrefix = raw.replace(/^\\\\\?\\/, "");
  const normalizedWindows = path.win32.normalize(withoutPrefix.replace(/\//g, "\\"));
  return normalizedWindows
    .replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`)
    .replace(/[\\\/]+$/, "");
}

function epochToIso(value: number): string {
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

function encodeProjectKey(normalizedCwd: string): string {
  return Buffer.from(normalizedCwd.toLowerCase(), "utf8").toString("base64url");
}

function preferDisplayCwd(current: string, next: string): string {
  return scoreDisplayCwd(next) > scoreDisplayCwd(current) ? next : current;
}

function scoreDisplayCwd(candidate: string): number {
  let score = 0;
  for (const char of candidate) {
    if (char >= "A" && char <= "Z") {
      score += 2;
    }
    if (char === "\\") {
      score += 1;
    }
  }
  return score;
}

function extractStateVersion(fileName: string): number {
  const match = fileName.match(/^state_(\d+)\.sqlite$/i);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

interface SessionIndexEntry {
  updatedAt: string;
  threadName: string;
}

interface SessionMeta {
  cwd: string;
  source: string;
  cliVersion: string;
  createdAt: string;
}
