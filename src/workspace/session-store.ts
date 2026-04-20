import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  BridgeAssetRecord,
  CodexPreferenceRecord,
  CodexProjectSelection,
  CodexThreadWatchStateRecord,
  CodexWindowBinding,
  CodexThreadRecord,
  ListRunsFilters,
  ObservabilityOverview,
  ObservabilityProjectSummary,
  ObservabilityRun,
  ObservabilityRunEvent,
  ObservabilityThreadSummary,
  PendingPlanInteractionRecord,
  ProgressStage,
  ProgressStatus,
  ProjectChatRecord,
  ProjectRecord,
  ReapableThread,
  RootProfile,
  SessionSnapshot,
  ThreadBinding,
} from "../types.js";

export class SessionStore {
  private readonly db: Database.Database;

  public constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  public upsertRoot(profile: RootProfile): void {
    const statement = this.db.prepare(`
      INSERT INTO bridge_root (
        slot, id, name, cwd, repo_root, branch_policy, permission_mode, env_allowlist, idle_ttl_hours
      ) VALUES (
        'default', @id, @name, @cwd, @repoRoot, @branchPolicy, @permissionMode, @envAllowlist, @idleTtlHours
      )
      ON CONFLICT(slot) DO UPDATE SET
        id = excluded.id,
        name = excluded.name,
        cwd = excluded.cwd,
        repo_root = excluded.repo_root,
        branch_policy = excluded.branch_policy,
        permission_mode = excluded.permission_mode,
        env_allowlist = excluded.env_allowlist,
        idle_ttl_hours = excluded.idle_ttl_hours
    `);

    statement.run({
      ...profile,
      envAllowlist: JSON.stringify(profile.envAllowlist),
    });
  }

  public getRoot(): RootProfile | undefined {
    const row = this.db.prepare(`
      SELECT id, name, cwd, repo_root, branch_policy, permission_mode, env_allowlist, idle_ttl_hours
      FROM bridge_root
      WHERE slot = 'default'
    `).get() as RootRow | undefined;

    return row ? rowToRoot(row) : undefined;
  }

  public bindThread(input: {
    channel: string;
    peerId: string;
    sessionName: string;
  }): void {
    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO thread_bindings (
        channel, peer_id, session_name, updated_at
      ) VALUES (
        @channel, @peerId, @sessionName, @updatedAt
      )
      ON CONFLICT(channel, peer_id) DO UPDATE SET
        session_name = excluded.session_name,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      updatedAt,
    });
  }

  public getBinding(channel: string, peerId: string): ThreadBinding | undefined {
    const row = this.db.prepare(`
      SELECT channel, peer_id, session_name, updated_at
      FROM thread_bindings
      WHERE channel = ? AND peer_id = ?
    `).get(channel, peerId) as BindingRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      channel: row.channel,
      peerId: row.peer_id,
      sessionName: row.session_name,
      updatedAt: row.updated_at,
    };
  }

  public bindCodexWindow(input: {
    channel: string;
    peerId: string;
    codexThreadId: string;
  }): void {
    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO codex_window_bindings (
        channel, peer_id, codex_thread_id, updated_at
      ) VALUES (
        @channel, @peerId, @codexThreadId, @updatedAt
      )
      ON CONFLICT(channel, peer_id) DO UPDATE SET
        codex_thread_id = excluded.codex_thread_id,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      updatedAt,
    });
  }

  public getCodexWindowBinding(channel: string, peerId: string): CodexWindowBinding | undefined {
    const row = this.db.prepare(`
      SELECT channel, peer_id, codex_thread_id, updated_at
      FROM codex_window_bindings
      WHERE channel = ? AND peer_id = ?
    `).get(channel, peerId) as CodexWindowBindingRow | undefined;

    return row ? rowToCodexWindowBinding(row) : undefined;
  }

  public clearCodexWindowBinding(channel: string, peerId: string): void {
    this.db.prepare(`
      DELETE FROM codex_window_bindings
      WHERE channel = ? AND peer_id = ?
    `).run(channel, peerId);
  }

  public setCodexProjectSelection(input: {
    channel: string;
    peerId: string;
    projectKey: string;
  }): void {
    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO codex_project_selections (
        channel, peer_id, project_key, updated_at
      ) VALUES (
        @channel, @peerId, @projectKey, @updatedAt
      )
      ON CONFLICT(channel, peer_id) DO UPDATE SET
        project_key = excluded.project_key,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      updatedAt,
    });
  }

  public getCodexProjectSelection(channel: string, peerId: string): CodexProjectSelection | undefined {
    const row = this.db.prepare(`
      SELECT channel, peer_id, project_key, updated_at
      FROM codex_project_selections
      WHERE channel = ? AND peer_id = ?
    `).get(channel, peerId) as CodexProjectSelectionRow | undefined;

    return row ? rowToCodexProjectSelection(row) : undefined;
  }

  public clearCodexProjectSelection(channel: string, peerId: string): void {
    this.db.prepare(`
      DELETE FROM codex_project_selections
      WHERE channel = ? AND peer_id = ?
    `).run(channel, peerId);
  }

  public upsertCodexThreadWatchState(input: {
    threadId: string;
    rolloutPath?: string;
    rolloutMtime?: string;
    lastReadOffset?: number;
    lastCompletionKey?: string | null;
    lastNotifiedCompletionKey?: string | null;
  }): void {
    const updatedAt = new Date().toISOString();
    const params = {
      ...input,
      rolloutPath: input.rolloutPath ?? null,
      rolloutPathProvided: Object.prototype.hasOwnProperty.call(input, "rolloutPath") ? 1 : 0,
      rolloutMtime: input.rolloutMtime ?? null,
      rolloutMtimeProvided: Object.prototype.hasOwnProperty.call(input, "rolloutMtime") ? 1 : 0,
      lastReadOffset: input.lastReadOffset ?? null,
      lastReadOffsetProvided: Object.prototype.hasOwnProperty.call(input, "lastReadOffset") ? 1 : 0,
      lastCompletionKey: input.lastCompletionKey ?? null,
      lastCompletionKeyProvided: Object.prototype.hasOwnProperty.call(input, "lastCompletionKey") ? 1 : 0,
      lastNotifiedCompletionKey: input.lastNotifiedCompletionKey ?? null,
      lastNotifiedCompletionKeyProvided:
        Object.prototype.hasOwnProperty.call(input, "lastNotifiedCompletionKey") ? 1 : 0,
      updatedAt,
    };

    const updateResult = this.db.prepare(`
      UPDATE codex_thread_watch_state
      SET
        rollout_path = CASE
          WHEN @rolloutPathProvided = 1 THEN @rolloutPath
          ELSE rollout_path
        END,
        rollout_mtime = CASE
          WHEN @rolloutMtimeProvided = 1 THEN @rolloutMtime
          ELSE rollout_mtime
        END,
        last_read_offset = CASE
          WHEN @lastReadOffsetProvided = 1 THEN @lastReadOffset
          ELSE last_read_offset
        END,
        last_completion_key = CASE
          WHEN @lastCompletionKeyProvided = 1 THEN @lastCompletionKey
          ELSE last_completion_key
        END,
        last_notified_completion_key = CASE
          WHEN @lastNotifiedCompletionKeyProvided = 1 THEN @lastNotifiedCompletionKey
          ELSE last_notified_completion_key
        END,
        updated_at = @updatedAt
      WHERE thread_id = @threadId
    `).run(params);

    if (updateResult.changes > 0) {
      return;
    }

    if (params.rolloutPathProvided === 0 || params.rolloutMtimeProvided === 0 || params.lastReadOffsetProvided === 0) {
      throw new RangeError(
        "New codex thread watch state rows require rolloutPath, rolloutMtime, and lastReadOffset",
      );
    }

    this.db.prepare(`
      INSERT INTO codex_thread_watch_state (
        thread_id,
        rollout_path,
        rollout_mtime,
        last_read_offset,
        last_completion_key,
        last_notified_completion_key,
        updated_at
      ) VALUES (
        @threadId,
        @rolloutPath,
        @rolloutMtime,
        @lastReadOffset,
        @lastCompletionKey,
        @lastNotifiedCompletionKey,
        @updatedAt
      )
    `).run(params);
  }

  public getCodexThreadWatchState(threadId: string): CodexThreadWatchStateRecord | undefined {
    const row = this.db.prepare(`
      SELECT
        thread_id,
        rollout_path,
        rollout_mtime,
        last_read_offset,
        last_completion_key,
        last_notified_completion_key,
        updated_at
      FROM codex_thread_watch_state
      WHERE thread_id = ?
    `).get(threadId) as CodexThreadWatchStateRow | undefined;

    return row ? rowToCodexThreadWatchState(row) : undefined;
  }

  public listCodexThreadWatchStates(): CodexThreadWatchStateRecord[] {
    const rows = this.db.prepare(`
      SELECT
        thread_id,
        rollout_path,
        rollout_mtime,
        last_read_offset,
        last_completion_key,
        last_notified_completion_key,
        updated_at
      FROM codex_thread_watch_state
      ORDER BY updated_at DESC, thread_id ASC
    `).all() as CodexThreadWatchStateRow[];

    return rows.map(rowToCodexThreadWatchState);
  }

  public upsertCodexThreadPreference(input: {
    threadId: string;
    model: string;
    reasoningEffort: CodexPreferenceRecord["reasoningEffort"];
    speed: CodexPreferenceRecord["speed"];
  }): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO codex_thread_preferences (
        thread_id, model, reasoning_effort, speed, updated_at
      ) VALUES (
        @threadId, @model, @reasoningEffort, @speed, @updatedAt
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        speed = excluded.speed,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      updatedAt,
    });
  }

  public getCodexThreadPreference(threadId: string): CodexPreferenceRecord | undefined {
    const row = this.db.prepare(`
      SELECT model, reasoning_effort, speed, updated_at
      FROM codex_thread_preferences
      WHERE thread_id = ?
    `).get(threadId) as CodexPreferenceRow | undefined;

    return row ? rowToCodexPreference(row) : undefined;
  }

  public deleteCodexThreadPreference(threadId: string): void {
    this.db.prepare(`
      DELETE FROM codex_thread_preferences
      WHERE thread_id = ?
    `).run(threadId);
  }

  public upsertCodexSurfacePreference(input: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
    model: string;
    reasoningEffort: CodexPreferenceRecord["reasoningEffort"];
    speed: CodexPreferenceRecord["speed"];
  }): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO codex_surface_preferences (
        surface_key, channel, peer_id, chat_id, surface_type, surface_ref, model, reasoning_effort, speed, updated_at
      ) VALUES (
        @surfaceKey, @channel, @peerId, @chatId, @surfaceType, @surfaceRef, @model, @reasoningEffort, @speed, @updatedAt
      )
      ON CONFLICT(surface_key) DO UPDATE SET
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        speed = excluded.speed,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
      surfaceKey: buildSurfacePreferenceKey(input),
      updatedAt,
    });
  }

  public getCodexSurfacePreference(input: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
  }): CodexPreferenceRecord | undefined {
    const row = this.db.prepare(`
      SELECT model, reasoning_effort, speed, updated_at
      FROM codex_surface_preferences
      WHERE surface_key = ?
    `).get(buildSurfacePreferenceKey(input)) as CodexPreferenceRow | undefined;

    return row ? rowToCodexPreference(row) : undefined;
  }

  public deleteCodexSurfacePreference(input: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
  }): void {
    this.db.prepare(`
      DELETE FROM codex_surface_preferences
      WHERE surface_key = ?
    `).run(buildSurfacePreferenceKey(input));
  }

  public createProject(input: ProjectRecord): void {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;

    this.db.prepare(`
      INSERT INTO projects (
        project_id, name, cwd, repo_root, created_at, updated_at
      ) VALUES (
        @projectId, @name, @cwd, @repoRoot, @createdAt, @updatedAt
      )
      ON CONFLICT(project_id) DO UPDATE SET
        name = excluded.name,
        cwd = excluded.cwd,
        repo_root = excluded.repo_root,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      createdAt,
      updatedAt,
    });
  }

  public getProject(projectId: string): ProjectRecord | undefined {
    const row = this.db.prepare(`
      SELECT project_id, name, cwd, repo_root, created_at, updated_at
      FROM projects
      WHERE project_id = ?
    `).get(projectId) as ProjectRow | undefined;

    return row ? rowToProject(row) : undefined;
  }

  public upsertProjectChat(input: ProjectChatRecord): void {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;

    this.db.prepare(`
      INSERT INTO project_chats (
        project_id, chat_id, group_message_type, title, is_active, created_at, updated_at
      ) VALUES (
        @projectId, @chatId, @groupMessageType, @title, @isActive, @createdAt, @updatedAt
      )
      ON CONFLICT(project_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        group_message_type = excluded.group_message_type,
        title = excluded.title,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      isActive: input.isActive ?? true ? 1 : 0,
      createdAt,
      updatedAt,
    });
  }

  public getProjectChat(projectId: string): ProjectChatRecord | undefined {
    const row = this.db.prepare(`
      SELECT project_id, chat_id, group_message_type, title, is_active, created_at, updated_at
      FROM project_chats
      WHERE project_id = ?
    `).get(projectId) as ProjectChatRow | undefined;

    return row ? rowToProjectChat(row) : undefined;
  }

  public getProjectChatByChatId(chatId: string): ProjectChatRecord | undefined {
    const row = this.db.prepare(`
      SELECT project_id, chat_id, group_message_type, title, is_active, created_at, updated_at
      FROM project_chats
      WHERE chat_id = ?
    `).get(chatId) as ProjectChatRow | undefined;

    return row ? rowToProjectChat(row) : undefined;
  }

  public clearProjectChatByChatId(chatId: string): void {
    this.db.prepare(`
      DELETE FROM project_chats
      WHERE chat_id = ?
    `).run(chatId);
  }

  public createCodexThread(input: CodexThreadRecord): void {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    const lastActivityAt = input.lastActivityAt ?? updatedAt;

    this.db.prepare(`
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
        @threadId,
        @projectId,
        @feishuThreadId,
        @chatId,
        @anchorMessageId,
        @latestMessageId,
        @sessionName,
        @title,
        @ownerOpenId,
        @status,
        @lastRunId,
        @lastActivityAt,
        @createdAt,
        @updatedAt,
        @archivedAt
      )
      ON CONFLICT(chat_id, feishu_thread_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        project_id = excluded.project_id,
        anchor_message_id = excluded.anchor_message_id,
        latest_message_id = excluded.latest_message_id,
        session_name = excluded.session_name,
        title = excluded.title,
        owner_open_id = excluded.owner_open_id,
        status = excluded.status,
        last_run_id = excluded.last_run_id,
        last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `).run({
      ...input,
      status: input.status ?? "provisioned",
      lastRunId: input.lastRunId ?? null,
      lastActivityAt,
      createdAt,
      updatedAt,
      archivedAt: input.archivedAt ?? null,
    });
  }

  public getCodexThreadBySurface(chatId: string, feishuThreadId: string): CodexThreadRecord | undefined {
    const row = this.db.prepare(`
      SELECT
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
      FROM codex_threads
      WHERE chat_id = ? AND feishu_thread_id = ?
    `).get(chatId, feishuThreadId) as CodexThreadRow | undefined;

    return row ? rowToCodexThread(row) : undefined;
  }

  public updateCodexThreadState(input: {
    threadId: string;
    status: CodexThreadRecord["status"];
    lastRunId?: string | null;
    lastActivityAt?: string;
    latestMessageId?: string;
    archivedAt?: string | null;
  }): void {
    const updatedAt = input.lastActivityAt ?? new Date().toISOString();

    this.db.prepare(`
      UPDATE codex_threads
      SET
        status = @status,
        last_run_id = COALESCE(@lastRunId, last_run_id),
        last_activity_at = @lastActivityAt,
        latest_message_id = COALESCE(@latestMessageId, latest_message_id),
        archived_at = CASE
          WHEN @archivedAtProvided = 1 THEN @archivedAt
          ELSE archived_at
        END,
        updated_at = @updatedAt
      WHERE thread_id = @threadId
    `).run({
      ...input,
      lastRunId: input.lastRunId ?? null,
      lastActivityAt: updatedAt,
      latestMessageId: input.latestMessageId ?? null,
      archivedAtProvided: Object.prototype.hasOwnProperty.call(input, "archivedAt") ? 1 : 0,
      archivedAt: input.archivedAt ?? null,
      updatedAt,
    });
  }

  public updateCodexThreadSession(input: {
    threadId: string;
    sessionName: string;
    status?: CodexThreadRecord["status"];
  }): void {
    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE codex_threads
      SET
        session_name = @sessionName,
        status = COALESCE(@status, status),
        updated_at = @updatedAt,
        last_activity_at = @updatedAt
      WHERE thread_id = @threadId
    `).run({
      ...input,
      status: input.status ?? null,
      updatedAt,
    });
  }

  public rebindCodexThreadSurface(input: {
    chatId: string;
    feishuThreadId: string;
    threadId: string;
    sessionName: string;
    title: string;
    status?: CodexThreadRecord["status"];
  }): void {
    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE codex_threads
      SET
        thread_id = @threadId,
        session_name = @sessionName,
        title = @title,
        status = COALESCE(@status, status),
        updated_at = @updatedAt,
        last_activity_at = @updatedAt
      WHERE chat_id = @chatId AND feishu_thread_id = @feishuThreadId
    `).run({
      ...input,
      status: input.status ?? null,
      updatedAt,
    });
  }

  public listReapableThreads(cutoffIso: string): ReapableThread[] {
    const rows = this.db.prepare(`
      SELECT
        ct.thread_id,
        ct.project_id,
        MIN(ct.session_name) AS session_name,
        p.cwd,
        MIN(ct.last_activity_at) AS last_activity_at
      FROM codex_threads AS ct
      INNER JOIN projects AS p
        ON p.project_id = ct.project_id
      WHERE
        ct.status = 'warm'
        AND ct.last_activity_at < ?
      GROUP BY ct.thread_id, ct.project_id, p.cwd
      ORDER BY MIN(ct.last_activity_at) ASC
    `).all(cutoffIso) as ReapableThreadRow[];

    return rows.map(rowToReapableThread);
  }

  public listProjects(): ObservabilityProjectSummary[] {
    const rows = this.db.prepare(`
      SELECT
        p.project_id,
        p.name,
        pc.chat_id,
        (
          SELECT COUNT(DISTINCT ct.thread_id)
          FROM codex_threads AS ct
          WHERE ct.project_id = p.project_id
        ) AS thread_count,
        (
          SELECT COUNT(DISTINCT ct.thread_id)
          FROM codex_threads AS ct
          WHERE ct.project_id = p.project_id AND ct.status = 'running'
        ) AS running_thread_count,
        MAX(COALESCE(pc.updated_at, p.updated_at)) AS updated_at
      FROM projects AS p
      LEFT JOIN project_chats AS pc
        ON pc.project_id = p.project_id
      GROUP BY p.project_id, p.name, pc.chat_id
      ORDER BY updated_at DESC, p.project_id ASC
    `).all() as ProjectSummaryRow[];

    return rows.map(rowToProjectSummary);
  }

  public listProjectThreads(projectId: string): ObservabilityThreadSummary[] {
    const rows = this.db.prepare(`
      SELECT
        thread_id,
        project_id,
        chat_id,
        feishu_thread_id,
        title,
        session_name,
        status,
        owner_open_id,
        anchor_message_id,
        latest_message_id,
        last_run_id,
        last_activity_at,
        updated_at,
        archived_at
      FROM codex_threads
      WHERE project_id = ?
      ORDER BY updated_at DESC, thread_id ASC
    `).all(projectId) as ThreadSummaryRow[];

    return rows.map(rowToThreadSummary);
  }

  public getThread(threadId: string): ObservabilityThreadSummary | undefined {
    const row = this.db.prepare(`
      SELECT
        thread_id,
        project_id,
        chat_id,
        feishu_thread_id,
        title,
        session_name,
        status,
        owner_open_id,
        anchor_message_id,
        latest_message_id,
        last_run_id,
        last_activity_at,
        updated_at,
        archived_at
      FROM codex_threads
      WHERE thread_id = ?
      ORDER BY updated_at DESC, chat_id ASC, feishu_thread_id ASC
      LIMIT 1
    `).get(threadId) as ThreadSummaryRow | undefined;

    return row ? rowToThreadSummary(row) : undefined;
  }

  public listThreadRuns(threadId: string, limit = 50): ObservabilityRun[] {
    const rows = this.db.prepare(`
      SELECT
        run_id,
        channel,
        peer_id,
        project_id,
        thread_id,
        delivery_chat_id,
        delivery_surface_type,
        delivery_surface_ref,
        session_name,
        root_id,
        status,
        stage,
        latest_preview,
        latest_tool,
        error_text,
        cancel_requested_at,
        cancel_requested_by,
        cancel_source,
        started_at,
        updated_at,
        finished_at
      FROM observability_runs
      WHERE thread_id = @threadId
      ORDER BY updated_at DESC
      LIMIT @limit
    `).all({
      threadId,
      limit: Math.min(Math.max(limit, 1), 200),
    }) as RunRow[];

    return rows.map(rowToRun);
  }

  public createRun(input: {
    runId: string;
    channel: string;
    peerId: string;
    projectId?: string | null;
    threadId?: string | null;
    deliveryChatId?: string | null;
    deliverySurfaceType?: "thread" | null;
    deliverySurfaceRef?: string | null;
    sessionName: string;
    rootId: string;
    status: ProgressStatus;
    stage: ProgressStage;
    latestPreview: string;
    latestTool?: string | null;
    errorText?: string | null;
    startedAt?: string;
    updatedAt?: string;
  }): void {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? startedAt;

    this.db.prepare(`
      INSERT INTO observability_runs (
        run_id,
        channel,
        peer_id,
        project_id,
        thread_id,
        delivery_chat_id,
        delivery_surface_type,
        delivery_surface_ref,
        session_name,
        root_id,
        status,
        stage,
        latest_preview,
        latest_tool,
        error_text,
        cancel_requested_at,
        cancel_requested_by,
        cancel_source,
        started_at,
        updated_at,
        finished_at
      ) VALUES (
        @runId,
        @channel,
        @peerId,
        @projectId,
        @threadId,
        @deliveryChatId,
        @deliverySurfaceType,
        @deliverySurfaceRef,
        @sessionName,
        @rootId,
        @status,
        @stage,
        @latestPreview,
        @latestTool,
        @errorText,
        NULL,
        NULL,
        NULL,
        @startedAt,
        @updatedAt,
        NULL
      )
    `).run({
      ...input,
      projectId: input.projectId ?? null,
      threadId: input.threadId ?? null,
      deliveryChatId: input.deliveryChatId ?? null,
      deliverySurfaceType: input.deliverySurfaceType ?? null,
      deliverySurfaceRef: input.deliverySurfaceRef ?? null,
      latestTool: input.latestTool ?? null,
      errorText: input.errorText ?? null,
      startedAt,
      updatedAt,
    });
  }

  public updateRunContext(input: {
    runId: string;
    sessionName: string;
    threadId?: string | null;
    projectId?: string | null;
    deliveryChatId?: string | null;
    deliverySurfaceType?: "thread" | null;
    deliverySurfaceRef?: string | null;
  }): void {
    this.db.prepare(`
      UPDATE observability_runs
      SET
        session_name = @sessionName,
        thread_id = @threadId,
        project_id = @projectId,
        delivery_chat_id = @deliveryChatId,
        delivery_surface_type = @deliverySurfaceType,
        delivery_surface_ref = @deliverySurfaceRef,
        updated_at = @updatedAt
      WHERE run_id = @runId
    `).run({
      ...input,
      threadId: input.threadId ?? null,
      projectId: input.projectId ?? null,
      deliveryChatId: input.deliveryChatId ?? null,
      deliverySurfaceType: input.deliverySurfaceType ?? null,
      deliverySurfaceRef: input.deliverySurfaceRef ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  public appendRunEvent(input: {
    runId: string;
    source: ObservabilityRunEvent["source"];
    status: ProgressStatus;
    stage: ProgressStage;
    preview: string;
    toolName?: string | null;
    createdAt?: string;
    coalesceSimilar?: boolean;
  }): void {
    const createdAt = input.createdAt ?? new Date().toISOString();

    const insertEvent = this.db.prepare(`
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
        @runId,
        @seq,
        @source,
        @status,
        @stage,
        @preview,
        @toolName,
        @createdAt
      )
    `);
    const updateExistingEvent = this.db.prepare(`
      UPDATE observability_run_events
      SET
        preview = @preview,
        tool_name = @toolName,
        created_at = @createdAt
      WHERE run_id = @runId AND seq = @seq
    `);
    const updateRun = this.db.prepare(`
      UPDATE observability_runs
      SET
        status = @status,
        stage = @stage,
        latest_preview = @preview,
        latest_tool = COALESCE(@toolName, latest_tool),
        error_text = CASE
          WHEN @status = 'error' THEN @preview
          ELSE error_text
        END,
        updated_at = @createdAt
      WHERE run_id = @runId
    `);

    this.db.transaction(() => {
      const latestEvent = this.db.prepare(`
        SELECT seq, source, status, stage, tool_name
        FROM observability_run_events
        WHERE run_id = ?
        ORDER BY seq DESC
        LIMIT 1
      `).get(input.runId) as LatestRunEventRow | undefined;
      const seqRow = this.db.prepare(`
        SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
        FROM observability_run_events
        WHERE run_id = ?
      `).get(input.runId) as {
        next_seq: number;
      };
      const toolName = input.toolName ?? null;
      const shouldCoalesce = Boolean(
        input.coalesceSimilar &&
        latestEvent &&
        latestEvent.source === input.source &&
        latestEvent.status === input.status &&
        latestEvent.stage === input.stage &&
        (latestEvent.tool_name ?? null) === toolName,
      );

      if (shouldCoalesce && latestEvent) {
        updateExistingEvent.run({
          ...input,
          seq: latestEvent.seq,
          toolName,
          createdAt,
        });
      } else {
        insertEvent.run({
          ...input,
          seq: seqRow.next_seq,
          toolName,
          createdAt,
        });
      }

      updateRun.run({
        ...input,
        toolName,
        createdAt,
      });
    })();
  }

  public markRunCancelRequested(input: {
    runId: string;
    requestedBy?: string | null;
    source: "feishu" | "ops";
    requestedAt?: string;
  }): void {
    const requestedAt = input.requestedAt ?? new Date().toISOString();

    this.db.prepare(`
      UPDATE observability_runs
      SET
        cancel_requested_at = @requestedAt,
        cancel_requested_by = @requestedBy,
        cancel_source = @source,
        updated_at = @requestedAt
      WHERE run_id = @runId
    `).run({
      ...input,
      requestedAt,
      requestedBy: input.requestedBy ?? null,
    });
  }

  public completeRun(input: {
    runId: string;
    status: ProgressStatus;
    stage: ProgressStage;
    latestPreview: string;
    latestTool?: string | null;
    errorText?: string | null;
    finishedAt?: string;
  }): void {
    const finishedAt = input.finishedAt ?? new Date().toISOString();

    this.db.prepare(`
      UPDATE observability_runs
      SET
        status = @status,
        stage = @stage,
        latest_preview = @latestPreview,
        latest_tool = COALESCE(@latestTool, latest_tool),
        error_text = CASE
          WHEN @status = 'error' THEN COALESCE(@errorText, @latestPreview)
          ELSE NULL
        END,
        updated_at = @finishedAt,
        finished_at = @finishedAt
      WHERE run_id = @runId
    `).run({
      ...input,
      latestTool: input.latestTool ?? null,
      errorText: input.errorText ?? null,
      finishedAt,
    });
  }

  public recoverInterruptedRuns(input?: {
    recoveredAt?: string;
    errorText?: string;
  }): number {
    const recoveredAt = input?.recoveredAt ?? new Date().toISOString();
    const errorText = input?.errorText ?? "[ca] run interrupted because the service restarted";
    const result = this.db.prepare(`
      UPDATE observability_runs
      SET
        status = 'error',
        stage = 'error',
        latest_preview = @errorText,
        error_text = @errorText,
        finished_at = COALESCE(finished_at, @recoveredAt)
      WHERE status NOT IN ('done', 'error', 'canceled')
    `).run({
      recoveredAt,
      errorText,
    });

    return result.changes;
  }

  public getOverview(): ObservabilityOverview {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM observability_runs) AS total_runs,
        (SELECT COUNT(*) FROM observability_runs WHERE status NOT IN ('done', 'error', 'canceled')) AS active_runs,
        (
          SELECT COUNT(*)
          FROM observability_runs
          WHERE status = 'done' AND finished_at IS NOT NULL AND finished_at >= @cutoff
        ) AS completed_runs_24h,
        (
          SELECT COUNT(*)
          FROM observability_runs
          WHERE status = 'error' AND finished_at IS NOT NULL AND finished_at >= @cutoff
        ) AS failed_runs_24h,
        (
          SELECT error_text
          FROM observability_runs
          WHERE error_text IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS latest_error,
        (
          SELECT
            COALESCE(cancel_requested_by, cancel_source, 'unknown') || ' @ ' || cancel_requested_at
          FROM observability_runs
          WHERE cancel_requested_at IS NOT NULL
          ORDER BY cancel_requested_at DESC
          LIMIT 1
        ) AS latest_cancel,
        (
          SELECT updated_at
          FROM observability_runs
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS updated_at
    `).get({ cutoff }) as {
      total_runs: number;
      active_runs: number;
      completed_runs_24h: number;
      failed_runs_24h: number;
      latest_error: string | null;
      latest_cancel: string | null;
      updated_at: string | null;
    };

    return {
      activeRuns: row.active_runs,
      queuedRuns: 0,
      cancelingRuns: 0,
      totalRuns: row.total_runs,
      completedRuns24h: row.completed_runs_24h,
      failedRuns24h: row.failed_runs_24h,
      longestActiveMs: 0,
      longestQueuedMs: 0,
      latestError: row.latest_error,
      latestCancel: row.latest_cancel,
      updatedAt: row.updated_at,
    };
  }

  public listRuns(filters: ListRunsFilters = {}): ObservabilityRun[] {
    const whereParts: string[] = [];
    const params: Record<string, string | number> = {};

    if (filters.status) {
      whereParts.push("status = @status");
      params.status = filters.status;
    }

    if (filters.peerId) {
      whereParts.push("peer_id = @peerId");
      params.peerId = filters.peerId;
    }

    if (filters.sessionName) {
      whereParts.push("session_name = @sessionName");
      params.sessionName = filters.sessionName;
    }

    if (filters.projectId) {
      whereParts.push("project_id = @projectId");
      params.projectId = filters.projectId;
    }

    if (filters.threadId) {
      whereParts.push("thread_id = @threadId");
      params.threadId = filters.threadId;
    }

    if (filters.deliveryChatId) {
      whereParts.push("delivery_chat_id = @deliveryChatId");
      params.deliveryChatId = filters.deliveryChatId;
    }

    if (filters.activeOnly) {
      whereParts.push("status NOT IN ('done', 'error', 'canceled')");
    }

    params.limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    const whereClause = whereParts.length > 0
      ? `WHERE ${whereParts.join(" AND ")}`
      : "";

    const rows = this.db.prepare(`
      SELECT
        run_id,
        channel,
        peer_id,
        project_id,
        thread_id,
        delivery_chat_id,
        delivery_surface_type,
        delivery_surface_ref,
        session_name,
        root_id,
        status,
        stage,
        latest_preview,
        latest_tool,
        error_text,
        cancel_requested_at,
        cancel_requested_by,
        cancel_source,
        started_at,
        updated_at,
        finished_at
      FROM observability_runs
      ${whereClause}
      ORDER BY
        updated_at DESC,
        run_id DESC
      LIMIT @limit
    `).all(params) as RunRow[];

    return rows.map(rowToRun);
  }

  public getRun(runId: string): ObservabilityRun | undefined {
    const row = this.db.prepare(`
      SELECT
        run_id,
        channel,
        peer_id,
        project_id,
        thread_id,
        delivery_chat_id,
        delivery_surface_type,
        delivery_surface_ref,
        session_name,
        root_id,
        status,
        stage,
        latest_preview,
        latest_tool,
        error_text,
        cancel_requested_at,
        cancel_requested_by,
        cancel_source,
        started_at,
        updated_at,
        finished_at
      FROM observability_runs
      WHERE run_id = ?
    `).get(runId) as RunRow | undefined;

    return row ? rowToRun(row) : undefined;
  }

  public listRunEvents(runId: string): ObservabilityRunEvent[] {
    const rows = this.db.prepare(`
      SELECT
        run_id,
        seq,
        source,
        status,
        stage,
        preview,
        tool_name,
        created_at
      FROM observability_run_events
      WHERE run_id = ?
      ORDER BY seq ASC
    `).all(runId) as RunEventRow[];

    return rows.map(rowToRunEvent);
  }

  public listSessionSnapshots(): SessionSnapshot[] {
    const rows = this.db.prepare(`
      SELECT
        tb.channel,
        tb.peer_id,
        tb.session_name,
        (
          SELECT run_id
          FROM observability_runs AS r
          WHERE
            r.channel = tb.channel
            AND r.peer_id = tb.peer_id
            AND r.session_name = tb.session_name
          ORDER BY r.updated_at DESC
          LIMIT 1
        ) AS latest_run_id,
        (
          SELECT status
          FROM observability_runs AS r
          WHERE
            r.channel = tb.channel
            AND r.peer_id = tb.peer_id
            AND r.session_name = tb.session_name
          ORDER BY r.updated_at DESC
          LIMIT 1
        ) AS latest_run_status,
        (
          SELECT stage
          FROM observability_runs AS r
          WHERE
            r.channel = tb.channel
            AND r.peer_id = tb.peer_id
            AND r.session_name = tb.session_name
          ORDER BY r.updated_at DESC
          LIMIT 1
        ) AS latest_run_stage,
        COALESCE(
          (
            SELECT updated_at
            FROM observability_runs AS r
            WHERE
              r.channel = tb.channel
              AND r.peer_id = tb.peer_id
              AND r.session_name = tb.session_name
            ORDER BY r.updated_at DESC
            LIMIT 1
          ),
          tb.updated_at
        ) AS updated_at
      FROM thread_bindings AS tb
      ORDER BY updated_at DESC, tb.peer_id ASC
    `).all() as SessionSnapshotRow[];

    return rows.map(rowToSessionSnapshot);
  }

  public savePendingPlanInteraction(input: {
    runId: string;
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
    threadId: string;
    sessionName: string;
    question: string;
    choices: PendingPlanInteractionRecord["choices"];
  }): PendingPlanInteractionRecord {
    const interactionId = `plan-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const updateExisting = this.db.prepare(`
      UPDATE pending_plan_interactions
      SET
        status = 'superseded',
        updated_at = @updatedAt,
        resolved_at = COALESCE(resolved_at, @updatedAt)
      WHERE
        status = 'pending'
        AND channel = @channel
        AND peer_id = @peerId
        AND COALESCE(chat_id, '') = COALESCE(@chatId, '')
        AND COALESCE(surface_type, '') = COALESCE(@surfaceType, '')
        AND COALESCE(surface_ref, '') = COALESCE(@surfaceRef, '')
    `);
    const insertInteraction = this.db.prepare(`
      INSERT INTO pending_plan_interactions (
        interaction_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        thread_id,
        session_name,
        question_text,
        choices_json,
        status,
        selected_choice_id,
        created_at,
        updated_at,
        resolved_at
      ) VALUES (
        @interactionId,
        @runId,
        @channel,
        @peerId,
        @chatId,
        @surfaceType,
        @surfaceRef,
        @threadId,
        @sessionName,
        @question,
        @choicesJson,
        'pending',
        NULL,
        @createdAt,
        @createdAt,
        NULL
      )
    `);

    this.db.transaction(() => {
      updateExisting.run({
        ...input,
        updatedAt: createdAt,
        chatId: input.chatId ?? null,
        surfaceType: input.surfaceType ?? null,
        surfaceRef: input.surfaceRef ?? null,
      });
      insertInteraction.run({
        ...input,
        interactionId,
        chatId: input.chatId ?? null,
        surfaceType: input.surfaceType ?? null,
        surfaceRef: input.surfaceRef ?? null,
        choicesJson: JSON.stringify(input.choices),
        createdAt,
      });
    })();

    const created = this.getPendingPlanInteraction(interactionId);
    if (!created) {
      throw new Error("PENDING_PLAN_INTERACTION_SAVE_FAILED");
    }

    return created;
  }

  public getPendingPlanInteraction(interactionId: string): PendingPlanInteractionRecord | undefined {
    const row = this.db.prepare(`
      SELECT
        interaction_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        thread_id,
        session_name,
        question_text,
        choices_json,
        status,
        selected_choice_id,
        created_at,
        updated_at,
        resolved_at
      FROM pending_plan_interactions
      WHERE interaction_id = ?
    `).get(interactionId) as PendingPlanInteractionRow | undefined;

    return row ? rowToPendingPlanInteraction(row) : undefined;
  }

  public getLatestPendingPlanInteractionForSurface(input: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
  }): PendingPlanInteractionRecord | undefined {
    const row = this.db.prepare(`
      SELECT
        interaction_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        thread_id,
        session_name,
        question_text,
        choices_json,
        status,
        selected_choice_id,
        created_at,
        updated_at,
        resolved_at
      FROM pending_plan_interactions
      WHERE
        status = 'pending'
        AND channel = @channel
        AND peer_id = @peerId
        AND COALESCE(chat_id, '') = COALESCE(@chatId, '')
        AND COALESCE(surface_type, '') = COALESCE(@surfaceType, '')
        AND COALESCE(surface_ref, '') = COALESCE(@surfaceRef, '')
      ORDER BY updated_at DESC, interaction_id DESC
      LIMIT 1
    `).get({
      ...input,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
    }) as PendingPlanInteractionRow | undefined;

    return row ? rowToPendingPlanInteraction(row) : undefined;
  }

  public resolvePendingPlanInteraction(input: {
    interactionId: string;
    selectedChoiceId?: string | null;
  }): void {
    const resolvedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE pending_plan_interactions
      SET
        status = 'resolved',
        selected_choice_id = @selectedChoiceId,
        updated_at = @resolvedAt,
        resolved_at = @resolvedAt
      WHERE interaction_id = @interactionId
    `).run({
      interactionId: input.interactionId,
      selectedChoiceId: input.selectedChoiceId ?? null,
      resolvedAt,
    });
  }

  public savePendingBridgeAsset(input: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
    runId?: string | null;
    messageId: string;
    resourceType?: BridgeAssetRecord["resourceType"];
    resourceKey: string;
    localPath: string;
    fileName: string;
    mimeType?: string | null;
    fileSize?: number | null;
    createdAt?: string;
  }): BridgeAssetRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const existing = this.getBridgeAssetByIdentity({
      channel: input.channel,
      peerId: input.peerId,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
      messageId: input.messageId,
      resourceKey: input.resourceKey,
    });

    if (existing) {
      return existing;
    }

    const assetId = buildBridgeAssetId({
      channel: input.channel,
      peerId: input.peerId,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
      messageId: input.messageId,
      resourceKey: input.resourceKey,
    });

    this.db.prepare(`
      INSERT INTO pending_bridge_assets (
        asset_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        message_id,
        resource_type,
        resource_key,
        local_path,
        file_name,
        mime_type,
        file_size,
        status,
        error_text,
        created_at,
        updated_at,
        consumed_at,
        failed_at,
        expired_at
      ) VALUES (
        @assetId,
        @runId,
        @channel,
        @peerId,
        @chatId,
        @surfaceType,
        @surfaceRef,
        @messageId,
        @resourceType,
        @resourceKey,
        @localPath,
        @fileName,
        @mimeType,
        @fileSize,
        'pending',
        NULL,
        @createdAt,
        @createdAt,
        NULL,
        NULL,
        NULL
      )
    `).run({
      assetId,
      runId: input.runId ?? null,
      channel: input.channel,
      peerId: input.peerId,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
      messageId: input.messageId,
      resourceType: input.resourceType ?? "image",
      resourceKey: input.resourceKey,
      localPath: input.localPath,
      fileName: input.fileName,
      mimeType: input.mimeType ?? null,
      fileSize: input.fileSize ?? null,
      createdAt,
    });

    const created = this.getBridgeAsset(assetId);
    if (!created) {
      throw new Error("PENDING_BRIDGE_ASSET_SAVE_FAILED");
    }

    return created;
  }

  private getBridgeAssetByIdentity(input: {
    channel: string;
    peerId: string;
    chatId: string | null;
    surfaceType: "thread" | null;
    surfaceRef: string | null;
    messageId: string;
    resourceKey: string;
  }): BridgeAssetRecord | undefined {
    const row = this.db.prepare(`
      SELECT
        asset_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        message_id,
        resource_type,
        resource_key,
        local_path,
        file_name,
        mime_type,
        file_size,
        status,
        error_text,
        created_at,
        updated_at,
        consumed_at,
        failed_at,
        expired_at
      FROM pending_bridge_assets
      WHERE
        channel = ?
        AND peer_id = ?
        AND COALESCE(chat_id, '') = COALESCE(?, '')
        AND COALESCE(surface_type, '') = COALESCE(?, '')
        AND COALESCE(surface_ref, '') = COALESCE(?, '')
        AND message_id = ?
        AND resource_key = ?
      ORDER BY rowid ASC
      LIMIT 1
    `).get(
      input.channel,
      input.peerId,
      input.chatId,
      input.surfaceType,
      input.surfaceRef,
      input.messageId,
      input.resourceKey,
    ) as BridgeAssetRow | undefined;

    return row ? rowToBridgeAsset(row) : undefined;
  }

  public getBridgeAsset(assetId: string): BridgeAssetRecord | undefined {
    const row = this.db.prepare(`
      SELECT
        asset_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        message_id,
        resource_type,
        resource_key,
        local_path,
        file_name,
        mime_type,
        file_size,
        status,
        error_text,
        created_at,
        updated_at,
        consumed_at,
        failed_at,
        expired_at
      FROM pending_bridge_assets
      WHERE asset_id = ?
    `).get(assetId) as BridgeAssetRow | undefined;

    return row ? rowToBridgeAsset(row) : undefined;
  }

  public listPendingBridgeAssetsForSurface(input: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
  }): BridgeAssetRecord[] {
    const rows = this.db.prepare(`
      SELECT
        asset_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        message_id,
        resource_type,
        resource_key,
        local_path,
        file_name,
        mime_type,
        file_size,
        status,
        error_text,
        created_at,
        updated_at,
        consumed_at,
        failed_at,
        expired_at
      FROM pending_bridge_assets
      WHERE
        status = 'pending'
        AND channel = @channel
        AND peer_id = @peerId
        AND COALESCE(chat_id, '') = COALESCE(@chatId, '')
        AND COALESCE(surface_type, '') = COALESCE(@surfaceType, '')
        AND COALESCE(surface_ref, '') = COALESCE(@surfaceRef, '')
      ORDER BY rowid ASC
    `).all({
      ...input,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
    }) as BridgeAssetRow[];

    return rows.map(rowToBridgeAsset);
  }

  public consumePendingBridgeAssetsForSurface(input: {
    runId: string;
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
  }): BridgeAssetRecord[] {
    const rows = this.db.prepare(`
      SELECT
        asset_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        message_id,
        resource_type,
        resource_key,
        local_path,
        file_name,
        mime_type,
        file_size,
        status,
        error_text,
        created_at,
        updated_at,
        consumed_at,
        failed_at,
        expired_at
      FROM pending_bridge_assets
      WHERE
        status = 'pending'
        AND channel = @channel
        AND peer_id = @peerId
        AND COALESCE(chat_id, '') = COALESCE(@chatId, '')
        AND COALESCE(surface_type, '') = COALESCE(@surfaceType, '')
        AND COALESCE(surface_ref, '') = COALESCE(@surfaceRef, '')
      ORDER BY rowid ASC
    `).all({
      ...input,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
    }) as BridgeAssetRow[];

    if (rows.length === 0) {
      return [];
    }

    return this.consumePendingBridgeAssets({
      runId: input.runId,
      assetIds: rows.map(row => row.asset_id),
    });
  }

  public consumePendingBridgeAssets(input: {
    runId: string;
    assetIds: string[];
  }): BridgeAssetRecord[] {
    if (input.assetIds.length === 0) {
      return [];
    }

    const consumedAt = new Date().toISOString();
    const placeholders = input.assetIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT
        asset_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        message_id,
        resource_type,
        resource_key,
        local_path,
        file_name,
        mime_type,
        file_size,
        status,
        error_text,
        created_at,
        updated_at,
        consumed_at,
        failed_at,
        expired_at
      FROM pending_bridge_assets
      WHERE
        status = 'pending'
        AND asset_id IN (${placeholders})
      ORDER BY rowid ASC
    `).all(...input.assetIds) as BridgeAssetRow[];

    if (rows.length === 0) {
      return [];
    }

    const selectedAssetIds = rows.map(row => row.asset_id);
    const updatePlaceholders = selectedAssetIds.map(() => "?").join(", ");

    this.db.prepare(`
      UPDATE pending_bridge_assets
      SET
        run_id = ?,
        status = 'consumed',
        updated_at = ?,
        consumed_at = ?
      WHERE asset_id IN (${updatePlaceholders})
    `).run(input.runId, consumedAt, consumedAt, ...selectedAssetIds);

    return rows.map(row => rowToBridgeAsset({
      ...row,
      run_id: input.runId,
      status: "consumed",
      updated_at: consumedAt,
      consumed_at: consumedAt,
    }));
  }

  public restoreConsumedBridgeAssets(input: {
    runId: string;
    assetIds: string[];
  }): BridgeAssetRecord[] {
    if (input.assetIds.length === 0) {
      return [];
    }

    const restoredAt = new Date().toISOString();
    const placeholders = input.assetIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT
        asset_id,
        run_id,
        channel,
        peer_id,
        chat_id,
        surface_type,
        surface_ref,
        message_id,
        resource_type,
        resource_key,
        local_path,
        file_name,
        mime_type,
        file_size,
        status,
        error_text,
        created_at,
        updated_at,
        consumed_at,
        failed_at,
        expired_at
      FROM pending_bridge_assets
      WHERE
        status = 'consumed'
        AND run_id = ?
        AND asset_id IN (${placeholders})
      ORDER BY created_at ASC, asset_id ASC
    `).all(input.runId, ...input.assetIds) as BridgeAssetRow[];

    if (rows.length === 0) {
      return [];
    }

    const selectedAssetIds = rows.map(row => row.asset_id);
    const updatePlaceholders = selectedAssetIds.map(() => "?").join(", ");

    this.db.prepare(`
      UPDATE pending_bridge_assets
      SET
        run_id = NULL,
        status = 'pending',
        updated_at = ?,
        consumed_at = NULL
      WHERE run_id = ?
        AND asset_id IN (${updatePlaceholders})
    `).run(restoredAt, input.runId, ...selectedAssetIds);

    return rows.map(row => rowToBridgeAsset({
      ...row,
      run_id: null,
      status: "pending",
      updated_at: restoredAt,
      consumed_at: null,
    }));
  }

  public failPendingBridgeAsset(input: {
    assetId: string;
    errorText?: string | null;
  }): BridgeAssetRecord | undefined {
    const failedAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE pending_bridge_assets
      SET
        status = 'failed',
        error_text = @errorText,
        updated_at = @failedAt,
        failed_at = @failedAt
      WHERE asset_id = @assetId
        AND status = 'pending'
    `).run({
      assetId: input.assetId,
      errorText: input.errorText ?? null,
      failedAt,
    });

    if (result.changes === 0) {
      return undefined;
    }

    return this.getBridgeAsset(input.assetId);
  }

  public expirePendingBridgeAssets(cutoff: string): number {
    const expiredAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE pending_bridge_assets
      SET
        status = 'expired',
        updated_at = @expiredAt,
        expired_at = @expiredAt
      WHERE status = 'pending'
        AND created_at < @cutoff
    `).run({
      cutoff,
      expiredAt,
    });

    return result.changes;
  }

  public purgeOldObservabilityEvents(maxAgeDays = 7): void {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    this.db.prepare(`
      DELETE FROM observability_run_events
      WHERE created_at < ?
    `).run(cutoff);
  }

  public close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_root (
        slot TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        branch_policy TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        env_allowlist TEXT NOT NULL,
        idle_ttl_hours INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_chats (
        project_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        group_message_type TEXT NOT NULL,
        title TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS codex_threads (
        binding_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
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
        UNIQUE(chat_id, feishu_thread_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS observability_runs (
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
        cancel_requested_at TEXT,
        cancel_requested_by TEXT,
        cancel_source TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS observability_run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        preview TEXT NOT NULL,
        tool_name TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES observability_runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pending_plan_interactions (
        interaction_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        chat_id TEXT,
        surface_type TEXT,
        surface_ref TEXT,
        thread_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        question_text TEXT NOT NULL,
        choices_json TEXT NOT NULL,
        status TEXT NOT NULL,
        selected_choice_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pending_bridge_assets (
        asset_id TEXT PRIMARY KEY,
        run_id TEXT,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        chat_id TEXT,
        surface_type TEXT,
        surface_ref TEXT,
        message_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        local_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER,
        status TEXT NOT NULL,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        consumed_at TEXT,
        failed_at TEXT,
        expired_at TEXT
      );

      CREATE TABLE IF NOT EXISTS codex_project_selections (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, peer_id)
      );

      CREATE TABLE IF NOT EXISTS codex_thread_watch_state (
        thread_id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        rollout_mtime TEXT NOT NULL,
        last_read_offset INTEGER NOT NULL,
        last_completion_key TEXT,
        last_notified_completion_key TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS codex_thread_preferences (
        thread_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        speed TEXT NOT NULL DEFAULT 'standard',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS codex_surface_preferences (
        surface_key TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        chat_id TEXT,
        surface_type TEXT,
        surface_ref TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        speed TEXT NOT NULL DEFAULT 'standard',
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_observability_runs_updated_at
      ON observability_runs(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_observability_runs_status
      ON observability_runs(status);

      CREATE INDEX IF NOT EXISTS idx_observability_runs_peer_session
      ON observability_runs(peer_id, session_name, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_observability_run_events_run_seq
      ON observability_run_events(run_id, seq);

      CREATE INDEX IF NOT EXISTS idx_pending_plan_interactions_surface
      ON pending_plan_interactions(channel, peer_id, chat_id, surface_type, surface_ref, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pending_plan_interactions_status
      ON pending_plan_interactions(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pending_bridge_assets_surface
      ON pending_bridge_assets(channel, peer_id, chat_id, surface_type, surface_ref, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pending_bridge_assets_status_created_at
      ON pending_bridge_assets(status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_codex_thread_watch_state_updated_at
      ON codex_thread_watch_state(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_codex_surface_preferences_lookup
      ON codex_surface_preferences(channel, peer_id, chat_id, surface_type, surface_ref);

    `);

    this.migrateLegacyRootTable();
    this.migrateThreadBindingsTable();
    this.migrateCodexThreadsTable();
    this.migrateCodexWindowBindingsTable();
    this.migrateObservabilityRunsTable();
    this.ensureObservabilityIndexes();
    this.migrateObservabilityEventSources();
    this.dropObsoleteTables();
    this.ensureCodexThreadIndexes();
    this.migrateCodexPreferenceTables();
  }

  private migrateLegacyRootTable(): void {
    const bridgeRootCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM bridge_root
    `).get() as {
      count: number;
    };

    if (bridgeRootCount.count > 0) {
      return;
    }

    const legacyColumns = this.db.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{
      name: string;
    }>;
    if (legacyColumns.length === 0) {
      return;
    }

    const legacyRoot = this.db.prepare(`
      SELECT
        id,
        name,
        cwd,
        repo_root,
        branch_policy,
        permission_mode,
        env_allowlist,
        idle_ttl_hours
      FROM workspaces
      ORDER BY id ASC
      LIMIT 1
    `).get() as LegacyWorkspaceRootRow | undefined;

    if (!legacyRoot) {
      return;
    }

    this.db.prepare(`
      INSERT INTO bridge_root (
        slot, id, name, cwd, repo_root, branch_policy, permission_mode, env_allowlist, idle_ttl_hours
      ) VALUES (
        'default', @id, @name, @cwd, @repo_root, @branch_policy, @permission_mode, @env_allowlist, @idle_ttl_hours
      )
    `).run(legacyRoot);
  }

  private migrateThreadBindingsTable(): void {
    const columns = this.db.prepare(`PRAGMA table_info(thread_bindings)`).all() as Array<{
      name: string;
    }>;

    if (columns.length === 0) {
      this.db.exec(`
        CREATE TABLE thread_bindings (
          channel TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          session_name TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel, peer_id)
        );
      `);
      return;
    }

    const hasWorkspaceId = columns.some(column => column.name === "workspace_id");
    if (!hasWorkspaceId) {
      return;
    }

    this.db.exec(`
      ALTER TABLE thread_bindings RENAME TO thread_bindings_legacy;

      CREATE TABLE thread_bindings (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, peer_id)
      );

      INSERT INTO thread_bindings (channel, peer_id, session_name, updated_at)
      SELECT channel, peer_id, session_name, updated_at
      FROM thread_bindings_legacy;

      DROP TABLE thread_bindings_legacy;
    `);
  }

  private migrateCodexThreadsTable(): void {
    const columns = this.db.prepare(`PRAGMA table_info(codex_threads)`).all() as Array<{
      name: string;
      pk: number;
    }>;

    if (columns.length === 0) {
      return;
    }

    const hasBindingId = columns.some(column => column.name === "binding_id");
    const threadIdColumn = columns.find(column => column.name === "thread_id");
    if (hasBindingId || threadIdColumn?.pk !== 1) {
      return;
    }

    this.db.exec(`
      ALTER TABLE codex_threads RENAME TO codex_threads_legacy;

      CREATE TABLE codex_threads (
        binding_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
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
        UNIQUE(chat_id, feishu_thread_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
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
      )
      SELECT
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
      FROM codex_threads_legacy
      ORDER BY updated_at ASC, chat_id ASC, feishu_thread_id ASC;

      DROP TABLE codex_threads_legacy;
    `);
  }

  private migrateObservabilityRunsTable(): void {
    const columns = this.db.prepare(`PRAGMA table_info(observability_runs)`).all() as Array<{
      name: string;
    }>;
    const requiredColumns = [
      { name: "project_id", definition: "TEXT" },
      { name: "thread_id", definition: "TEXT" },
      { name: "delivery_chat_id", definition: "TEXT" },
      { name: "delivery_surface_type", definition: "TEXT" },
      { name: "delivery_surface_ref", definition: "TEXT" },
      { name: "cancel_requested_at", definition: "TEXT" },
      { name: "cancel_requested_by", definition: "TEXT" },
      { name: "cancel_source", definition: "TEXT" },
    ];

    for (const column of requiredColumns) {
      if (columns.some(existing => existing.name === column.name)) {
        continue;
      }

      this.db.exec(`
        ALTER TABLE observability_runs
        ADD COLUMN ${column.name} ${column.definition};
      `);
    }
  }

  private migrateObservabilityEventSources(): void {
    this.db.prepare(`
      UPDATE observability_run_events
      SET source = 'runner'
      WHERE source = 'acpx'
    `).run();
  }

  private ensureObservabilityIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observability_runs_cancel_requested_at
      ON observability_runs(cancel_requested_at DESC);
    `);
  }

  private migrateCodexWindowBindingsTable(): void {
    const columns = this.db.prepare(`PRAGMA table_info(codex_window_bindings)`).all() as Array<{
      name: string;
    }>;

    if (columns.length > 0) {
      return;
    }

    this.db.exec(`
      CREATE TABLE codex_window_bindings (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, peer_id)
      );
    `);
  }

  private ensureCodexThreadIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_codex_threads_surface
      ON codex_threads(chat_id, feishu_thread_id);

      CREATE INDEX IF NOT EXISTS idx_codex_threads_thread_id
      ON codex_threads(thread_id, updated_at DESC);
    `);
  }

  private migrateCodexPreferenceTables(): void {
    const threadColumns = this.db.prepare(`PRAGMA table_info(codex_thread_preferences)`).all() as Array<{
      name: string;
    }>;
    if (threadColumns.some(column => column.name === "speed") === false) {
      this.db.exec(`
        ALTER TABLE codex_thread_preferences
        ADD COLUMN speed TEXT NOT NULL DEFAULT 'standard'
      `);
    }

    const surfaceColumns = this.db.prepare(`PRAGMA table_info(codex_surface_preferences)`).all() as Array<{
      name: string;
    }>;
    if (surfaceColumns.some(column => column.name === "speed") === false) {
      this.db.exec(`
        ALTER TABLE codex_surface_preferences
        ADD COLUMN speed TEXT NOT NULL DEFAULT 'standard'
      `);
    }
  }

  private dropObsoleteTables(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS workspaces;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS acp_sessions;
      DROP TABLE IF EXISTS runs;
      DROP TABLE IF EXISTS message_links;
      DROP TABLE IF EXISTS event_offsets;
    `);
  }
}

interface RootRow {
  id: string;
  name: string;
  cwd: string;
  repo_root: string;
  branch_policy: string;
  permission_mode: RootProfile["permissionMode"];
  env_allowlist: string;
  idle_ttl_hours: number;
}

interface BindingRow {
  channel: string;
  peer_id: string;
  session_name: string;
  updated_at: string;
}

interface CodexWindowBindingRow {
  channel: string;
  peer_id: string;
  codex_thread_id: string;
  updated_at: string;
}

interface CodexProjectSelectionRow {
  channel: string;
  peer_id: string;
  project_key: string;
  updated_at: string;
}

interface CodexThreadWatchStateRow {
  thread_id: string;
  rollout_path: string;
  rollout_mtime: string;
  last_read_offset: number;
  last_completion_key: string | null;
  last_notified_completion_key: string | null;
  updated_at: string;
}

interface CodexPreferenceRow {
  model: string;
  reasoning_effort: CodexPreferenceRecord["reasoningEffort"];
  speed: CodexPreferenceRecord["speed"];
  updated_at: string;
}

interface RunRow {
  run_id: string;
  channel: string;
  peer_id: string;
  project_id: string | null;
  thread_id: string | null;
  delivery_chat_id: string | null;
  delivery_surface_type: "thread" | null;
  delivery_surface_ref: string | null;
  session_name: string;
  root_id: string;
  status: ProgressStatus;
  stage: ProgressStage;
  latest_preview: string;
  latest_tool: string | null;
  error_text: string | null;
  cancel_requested_at: string | null;
  cancel_requested_by: string | null;
  cancel_source: "feishu" | "ops" | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RunEventRow {
  run_id: string;
  seq: number;
  source: ObservabilityRunEvent["source"];
  status: ProgressStatus;
  stage: ProgressStage;
  preview: string;
  tool_name: string | null;
  created_at: string;
}

interface LatestRunEventRow {
  seq: number;
  source: ObservabilityRunEvent["source"];
  status: ProgressStatus;
  stage: ProgressStage;
  tool_name: string | null;
}

interface SessionSnapshotRow {
  channel: string;
  peer_id: string;
  session_name: string;
  latest_run_id: string | null;
  latest_run_status: ProgressStatus | null;
  latest_run_stage: ProgressStage | null;
  updated_at: string;
}

interface PendingPlanInteractionRow {
  interaction_id: string;
  run_id: string;
  channel: string;
  peer_id: string;
  chat_id: string | null;
  surface_type: "thread" | null;
  surface_ref: string | null;
  thread_id: string;
  session_name: string;
  question_text: string;
  choices_json: string;
  status: PendingPlanInteractionRecord["status"];
  selected_choice_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface BridgeAssetRow {
  asset_id: string;
  run_id: string | null;
  channel: string;
  peer_id: string;
  chat_id: string | null;
  surface_type: "thread" | null;
  surface_ref: string | null;
  message_id: string;
  resource_type: BridgeAssetRecord["resourceType"];
  resource_key: string;
  local_path: string;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  status: BridgeAssetRecord["status"];
  error_text: string | null;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
  failed_at: string | null;
  expired_at: string | null;
}

interface CodexThreadRow {
  thread_id: string;
  project_id: string;
  feishu_thread_id: string;
  chat_id: string;
  anchor_message_id: string;
  latest_message_id: string;
  session_name: string;
  title: string;
  owner_open_id: string;
  status: CodexThreadRecord["status"];
  last_run_id: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ProjectRow {
  project_id: string;
  name: string;
  cwd: string;
  repo_root: string;
  created_at: string;
  updated_at: string;
}

interface ProjectChatRow {
  project_id: string;
  chat_id: string;
  group_message_type: string;
  title: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface ProjectSummaryRow {
  project_id: string;
  name: string;
  chat_id: string | null;
  thread_count: number;
  running_thread_count: number;
  updated_at: string;
}

interface ThreadSummaryRow {
  thread_id: string;
  project_id: string;
  chat_id: string;
  feishu_thread_id: string;
  title: string;
  session_name: string;
  status: CodexThreadRecord["status"];
  owner_open_id: string;
  anchor_message_id: string;
  latest_message_id: string;
  last_run_id: string | null;
  last_activity_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ReapableThreadRow {
  thread_id: string;
  project_id: string;
  session_name: string;
  cwd: string;
  last_activity_at: string;
}

interface LegacyWorkspaceRootRow {
  id: string;
  name: string;
  cwd: string;
  repo_root: string;
  branch_policy: string;
  permission_mode: RootProfile["permissionMode"];
  env_allowlist: string;
  idle_ttl_hours: number;
}

function rowToRoot(row: RootRow): RootProfile {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    repoRoot: row.repo_root,
    branchPolicy: row.branch_policy,
    permissionMode: row.permission_mode,
    envAllowlist: JSON.parse(row.env_allowlist) as string[],
    idleTtlHours: row.idle_ttl_hours,
  };
}

function rowToRun(row: RunRow): ObservabilityRun {
  return {
    runId: row.run_id,
    channel: row.channel,
    peerId: row.peer_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    deliveryChatId: row.delivery_chat_id,
    deliverySurfaceType: row.delivery_surface_type,
    deliverySurfaceRef: row.delivery_surface_ref,
    sessionName: row.session_name,
    rootId: row.root_id,
    status: row.status,
    stage: row.stage,
    latestPreview: row.latest_preview,
    latestTool: row.latest_tool,
    errorText: row.error_text,
    cancelRequestedAt: row.cancel_requested_at,
    cancelRequestedBy: row.cancel_requested_by,
    cancelSource: row.cancel_source,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function rowToRunEvent(row: RunEventRow): ObservabilityRunEvent {
  return {
    runId: row.run_id,
    seq: row.seq,
    source: row.source,
    status: row.status,
    stage: row.stage,
    preview: row.preview,
    toolName: row.tool_name,
    createdAt: row.created_at,
  };
}

function rowToSessionSnapshot(row: SessionSnapshotRow): SessionSnapshot {
  return {
    channel: row.channel,
    peerId: row.peer_id,
    sessionName: row.session_name,
    latestRunId: row.latest_run_id,
    latestRunStatus: row.latest_run_status,
    latestRunStage: row.latest_run_stage,
    updatedAt: row.updated_at,
  };
}

function rowToPendingPlanInteraction(row: PendingPlanInteractionRow): PendingPlanInteractionRecord {
  return {
    interactionId: row.interaction_id,
    runId: row.run_id,
    channel: row.channel,
    peerId: row.peer_id,
    chatId: row.chat_id,
    surfaceType: row.surface_type,
    surfaceRef: row.surface_ref,
    threadId: row.thread_id,
    sessionName: row.session_name,
    question: row.question_text,
    choices: JSON.parse(row.choices_json) as PendingPlanInteractionRecord["choices"],
    status: row.status,
    selectedChoiceId: row.selected_choice_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function rowToBridgeAsset(row: BridgeAssetRow): BridgeAssetRecord {
  return {
    assetId: row.asset_id,
    runId: row.run_id,
    channel: row.channel,
    peerId: row.peer_id,
    chatId: row.chat_id,
    surfaceType: row.surface_type,
    surfaceRef: row.surface_ref,
    messageId: row.message_id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    localPath: row.local_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    status: row.status,
    errorText: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at,
    failedAt: row.failed_at,
    expiredAt: row.expired_at,
  };
}

function buildBridgeAssetId(input: {
  channel: string;
  peerId: string;
  chatId: string | null;
  surfaceType: "thread" | null;
  surfaceRef: string | null;
  messageId: string;
  resourceKey: string;
}): string {
  const identity = [
    input.channel,
    input.peerId,
    input.chatId ?? "",
    input.surfaceType ?? "",
    input.surfaceRef ?? "",
    input.messageId,
    input.resourceKey,
  ].join("|");

  return `asset-${createHash("sha256").update(identity).digest("hex")}`;
}

function buildSurfacePreferenceKey(input: {
  channel: string;
  peerId: string;
  chatId?: string | null;
  surfaceType?: "thread" | null;
  surfaceRef?: string | null;
}): string {
  const identity = [
    input.channel,
    input.peerId,
    input.chatId ?? "",
    input.surfaceType ?? "",
    input.surfaceRef ?? "",
  ].join("|");

  return `surface-${createHash("sha256").update(identity).digest("hex")}`;
}

function rowToCodexWindowBinding(row: CodexWindowBindingRow): CodexWindowBinding {
  return {
    channel: row.channel,
    peerId: row.peer_id,
    codexThreadId: row.codex_thread_id,
    updatedAt: row.updated_at,
  };
}

function rowToCodexProjectSelection(row: CodexProjectSelectionRow): CodexProjectSelection {
  return {
    channel: row.channel,
    peerId: row.peer_id,
    projectKey: row.project_key,
    updatedAt: row.updated_at,
  };
}

function rowToCodexThreadWatchState(row: CodexThreadWatchStateRow): CodexThreadWatchStateRecord {
  return {
    threadId: row.thread_id,
    rolloutPath: row.rollout_path,
    rolloutMtime: row.rollout_mtime,
    lastReadOffset: row.last_read_offset,
    lastCompletionKey: row.last_completion_key,
    lastNotifiedCompletionKey: row.last_notified_completion_key,
    updatedAt: row.updated_at,
  };
}

function rowToCodexPreference(row: CodexPreferenceRow): CodexPreferenceRecord {
  return {
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    speed: row.speed,
    updatedAt: row.updated_at,
  };
}

function rowToCodexThread(row: CodexThreadRow): CodexThreadRecord {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    feishuThreadId: row.feishu_thread_id,
    chatId: row.chat_id,
    anchorMessageId: row.anchor_message_id,
    latestMessageId: row.latest_message_id,
    sessionName: row.session_name,
    title: row.title,
    ownerOpenId: row.owner_open_id,
    status: row.status,
    lastRunId: row.last_run_id,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id,
    name: row.name,
    cwd: row.cwd,
    repoRoot: row.repo_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProjectChat(row: ProjectChatRow): ProjectChatRecord {
  return {
    projectId: row.project_id,
    chatId: row.chat_id,
    groupMessageType: row.group_message_type,
    title: row.title,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProjectSummary(row: ProjectSummaryRow): ObservabilityProjectSummary {
  return {
    projectId: row.project_id,
    name: row.name,
    chatId: row.chat_id,
    threadCount: row.thread_count,
    runningThreadCount: row.running_thread_count,
    updatedAt: row.updated_at,
  };
}

function rowToThreadSummary(row: ThreadSummaryRow): ObservabilityThreadSummary {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    chatId: row.chat_id,
    feishuThreadId: row.feishu_thread_id,
    title: row.title,
    sessionName: row.session_name,
    status: row.status ?? "provisioned",
    ownerOpenId: row.owner_open_id,
    anchorMessageId: row.anchor_message_id,
    latestMessageId: row.latest_message_id,
    lastRunId: row.last_run_id,
    lastActivityAt: row.last_activity_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToReapableThread(row: ReapableThreadRow): ReapableThread {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    sessionName: row.session_name,
    cwd: row.cwd,
    lastActivityAt: row.last_activity_at,
  };
}
