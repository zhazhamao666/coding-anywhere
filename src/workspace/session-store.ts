import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  CodexWindowBinding,
  CodexThreadRecord,
  ListRunsFilters,
  ObservabilityOverview,
  ObservabilityProjectSummary,
  ObservabilityRun,
  ObservabilityRunEvent,
  ObservabilityThreadSummary,
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
      updated_at: string | null;
    };

    return {
      activeRuns: row.active_runs,
      totalRuns: row.total_runs,
      completedRuns24h: row.completed_runs_24h,
      failedRuns24h: row.failed_runs_24h,
      latestError: row.latest_error,
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
        started_at,
        updated_at,
        finished_at
      FROM observability_runs
      ${whereClause}
      ORDER BY
        CASE WHEN status IN ('done', 'error', 'canceled') THEN 1 ELSE 0 END,
        updated_at DESC
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

      CREATE INDEX IF NOT EXISTS idx_observability_runs_updated_at
      ON observability_runs(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_observability_runs_status
      ON observability_runs(status);

      CREATE INDEX IF NOT EXISTS idx_observability_runs_peer_session
      ON observability_runs(peer_id, session_name, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_observability_run_events_run_seq
      ON observability_run_events(run_id, seq);

    `);

    this.migrateLegacyRootTable();
    this.migrateThreadBindingsTable();
    this.migrateCodexThreadsTable();
    this.migrateCodexWindowBindingsTable();
    this.migrateObservabilityRunsTable();
    this.dropObsoleteTables();
    this.ensureCodexThreadIndexes();
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

function rowToCodexWindowBinding(row: CodexWindowBindingRow): CodexWindowBinding {
  return {
    channel: row.channel,
    peerId: row.peer_id,
    codexThreadId: row.codex_thread_id,
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
