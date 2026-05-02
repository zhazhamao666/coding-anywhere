import Fastify from "fastify";

import { createMetricsRegistry } from "./ops.js";
import {
  RUNTIME_STAGE_LABELS,
  RUNTIME_STATUS_LABELS,
} from "./runtime-status-labels.js";
import type {
  ListRunsFilters,
  ObservabilityOverview,
  ObservabilityProjectSummary,
  ObservabilityRun,
  ObservabilityRunEvent,
  ObservabilityThreadSummary,
  RuntimeSnapshot,
  SessionSnapshot,
} from "./types.js";

interface ObservabilityProvider {
  getOverview(): Promise<ObservabilityOverview> | ObservabilityOverview;
  listRuns(filters: ListRunsFilters): Promise<ObservabilityRun[]> | ObservabilityRun[];
  getRun(runId: string): Promise<ObservabilityRun | undefined> | ObservabilityRun | undefined;
  listRunEvents(runId: string): Promise<ObservabilityRunEvent[]> | ObservabilityRunEvent[];
  listSessionSnapshots(): Promise<SessionSnapshot[]> | SessionSnapshot[];
  listProjects?(): Promise<ObservabilityProjectSummary[]> | ObservabilityProjectSummary[];
  listProjectThreads?(projectId: string): Promise<ObservabilityThreadSummary[]> | ObservabilityThreadSummary[];
  getThread?(threadId: string): Promise<ObservabilityThreadSummary | undefined> | ObservabilityThreadSummary | undefined;
  listThreadRuns?(threadId: string): Promise<ObservabilityRun[]> | ObservabilityRun[];
  getRuntimeSnapshot?(): Promise<RuntimeSnapshot> | RuntimeSnapshot;
  cancelRun?(runId: string): Promise<{
    accepted: boolean;
    runId: string;
    newStatus: string;
    message: string;
  }> | {
    accepted: boolean;
    runId: string;
    newStatus: string;
    message: string;
  };
}

export function buildApp(options?: {
  readinessProbe?: () => Promise<boolean> | boolean;
  observability?: ObservabilityProvider;
}) {
  const app = Fastify();
  const registry = createMetricsRegistry();
  const readinessProbe = options?.readinessProbe ?? (() => true);
  const observability = options?.observability;

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    const ready = await readinessProbe();
    if (!ready) {
      reply.code(503);
      return { status: "not-ready" };
    }

    return { status: "ready" };
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  if (observability) {
    app.get("/ops/overview", async () => observability.getOverview());
    app.get("/ops/runs", async request => {
      const query = request.query as {
        status?: ListRunsFilters["status"];
        peer_id?: string;
        session_name?: string;
        project_id?: string;
        thread_id?: string;
        delivery_chat_id?: string;
        active_only?: string;
        limit?: string;
      };

      return observability.listRuns({
        status: query.status,
        peerId: query.peer_id,
        sessionName: query.session_name,
        projectId: query.project_id,
        threadId: query.thread_id,
        deliveryChatId: query.delivery_chat_id,
        activeOnly: query.active_only === "1" || query.active_only === "true",
        limit: query.limit ? Number(query.limit) : undefined,
      });
    });
    app.get("/ops/runs/:id", async (request, reply) => {
      const params = request.params as {
        id: string;
      };
      const run = await observability.getRun(params.id);

      if (!run) {
        reply.code(404);
        return { status: "not-found" };
      }

      return {
        run,
        events: await observability.listRunEvents(params.id),
      };
    });
    app.get("/ops/sessions", async () => observability.listSessionSnapshots());
    if (observability.getRuntimeSnapshot) {
      app.get("/ops/runtime", async () => observability.getRuntimeSnapshot?.());
    }
    if (observability.cancelRun) {
      app.post("/ops/runs/:id/cancel", async request => {
        const params = request.params as {
          id: string;
        };
        return observability.cancelRun?.(params.id);
      });
    }
    if (observability.listProjects) {
      app.get("/ops/projects", async () => observability.listProjects?.() ?? []);
    }
    if (observability.listProjectThreads) {
      app.get("/ops/projects/:id/threads", async request => {
        const params = request.params as {
          id: string;
        };
        return observability.listProjectThreads?.(params.id) ?? [];
      });
    }
    if (observability.getThread) {
      app.get("/ops/threads/:id", async (request, reply) => {
        const params = request.params as {
          id: string;
        };
        const thread = await observability.getThread?.(params.id);

        if (!thread) {
          reply.code(404);
          return { status: "not-found" };
        }

        return thread;
      });
    }
    if (observability.listThreadRuns) {
      app.get("/ops/threads/:id/runs", async request => {
        const params = request.params as {
          id: string;
        };
        return observability.listThreadRuns?.(params.id) ?? [];
      });
    }
    app.get("/ops/ui", async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      return buildOpsUiHtml();
    });
  }

  return app;
}

function buildOpsUiHtml(): string {
  const statusLabelsJson = JSON.stringify(RUNTIME_STATUS_LABELS);
  const stageLabelsJson = JSON.stringify(RUNTIME_STAGE_LABELS);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Backend Observability</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f6fb;
        --panel: #ffffff;
        --line: #d8deed;
        --text: #122033;
        --muted: #5f6f86;
        --accent: #0b6efd;
        --accent-soft: #e7f0ff;
        --danger: #c92a2a;
        --warn: #b97100;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        background:
          radial-gradient(circle at top right, #dce8ff 0, transparent 28%),
          linear-gradient(180deg, #f9fbff 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        max-width: 1440px;
        margin: 0 auto;
        padding: 24px;
      }

      h1, h2 {
        margin: 0;
      }

      .subtle {
        color: var(--muted);
      }

      .overview {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
        margin-top: 20px;
      }

      .card,
      .panel {
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid var(--line);
        border-radius: 18px;
        box-shadow: 0 12px 40px rgba(33, 56, 110, 0.08);
      }

      .card {
        padding: 18px;
      }

      .card strong {
        display: block;
        font-size: 28px;
        margin-top: 8px;
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(420px, 1.15fr) minmax(380px, 0.85fr);
        gap: 16px;
        margin-top: 20px;
      }

      .panel {
        min-height: 540px;
        overflow: hidden;
      }

      .panel header {
        padding: 18px 20px;
        border-bottom: 1px solid var(--line);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .panel-body {
        padding: 12px;
      }

      .stack,
      .runs {
        display: grid;
        gap: 10px;
      }

      .run {
        border: 1px solid transparent;
        border-radius: 14px;
        padding: 14px;
        background: #f8faff;
      }

      .run.selectable {
        cursor: pointer;
      }

      .run.selectable.active {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .run.selectable:hover {
        border-color: #8fb6ff;
      }

      .section-block {
        display: grid;
        gap: 10px;
        padding: 14px 12px;
        border-radius: 16px;
        background: rgba(248, 250, 255, 0.8);
        border: 1px solid rgba(216, 222, 237, 0.8);
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .section-title {
        font-size: 16px;
        font-weight: 700;
      }

      .section-note {
        font-size: 12px;
        color: var(--muted);
      }

      .run-top,
      .detail-grid,
      .session-row {
        display: grid;
        gap: 10px;
      }

      .run-top {
        grid-template-columns: 110px 1fr;
        align-items: center;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 600;
        background: #eaf1ff;
        color: #174ea6;
      }

      .badge.error {
        background: #fdecec;
        color: var(--danger);
      }

      .badge.tool_active {
        background: #fff0d6;
        color: var(--warn);
      }

      .badge.canceling {
        background: #fef3d8;
        color: #8a5300;
      }

      .muted-line {
        font-size: 13px;
        color: var(--muted);
      }

      .detail-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin-bottom: 16px;
      }

      .kv {
        padding: 12px;
        border-radius: 12px;
        background: #f8faff;
      }

      .kv label {
        display: block;
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 6px;
      }

      .timeline {
        display: grid;
        gap: 10px;
      }

      .detail-section {
        margin-bottom: 16px;
      }

      .event {
        padding: 12px;
        border-left: 3px solid #b7c8ea;
        background: #f8faff;
        border-radius: 0 12px 12px 0;
      }

      .event-top {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
      }

      .sessions {
        margin-top: 16px;
        border-top: 1px solid var(--line);
        padding-top: 16px;
        display: grid;
        gap: 10px;
      }

      .session-row {
        grid-template-columns: 1fr auto;
        padding: 12px;
        background: #f8faff;
        border-radius: 12px;
      }

      code {
        font-family: "Cascadia Code", "Consolas", monospace;
        font-size: 12px;
      }

      @media (max-width: 1024px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div>
        <h1>Backend Observability</h1>
        <p class="subtle">任务级后台观测页面，核心数据来源于 <code>/ops/overview</code>、<code>/ops/runtime</code>、<code>/ops/runs</code>、<code>/ops/runs/:id</code>、<code>/ops/sessions</code>，项目与 Codex 线程 ID 补充视图可通过 <code>/ops/projects</code> 与 <code>/ops/threads/:id</code> 获取。</p>
      </div>

      <section class="overview" id="overview"></section>

      <section class="layout">
        <div class="panel">
          <header>
            <div>
              <h2>告警与任务队列</h2>
              <div class="subtle" id="runtime-meta">加载中...</div>
            </div>
            <button id="refresh" type="button">刷新</button>
          </header>
          <div class="panel-body">
            <div class="stack" id="runtime"></div>
            <div class="stack" id="incidents"></div>
            <div class="stack" id="runs"></div>
            <div class="sessions" id="sessions"></div>
          </div>
        </div>

        <div class="panel">
          <header>
            <div>
              <h2>任务详情</h2>
              <div class="subtle" id="detail-meta">点击左侧任务查看时间线</div>
            </div>
          </header>
          <div class="panel-body">
            <div id="detail"></div>
          </div>
        </div>
      </section>
    </main>

    <script>
      const state = { selectedRunId: null };
      const STATUS_LABELS = ${statusLabelsJson};
      const STAGE_LABELS = ${stageLabelsJson};

      function statusBadgeClass(status) {
        if (status === "error") return "badge error";
        if (status === "tool_active") return "badge tool_active";
        if (status === "canceling") return "badge canceling";
        return "badge";
      }

      function formatStatusLabel(status) {
        if (!status) return "-";
        return STATUS_LABELS[status] || status;
      }

      function formatStageLabel(stage) {
        if (!stage) return "-";
        return STAGE_LABELS[stage] || stage;
      }

      function renderStatusPair(status, stage) {
        return escapeHtml(formatStatusLabel(status)) + " / " + escapeHtml(formatStageLabel(stage));
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      async function loadJson(url) {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) {
          throw new Error(url + " => " + response.status);
        }
        return response.json();
      }

      async function refreshDashboard() {
        const [overview, runtime, failedRuns, canceledRuns, runs, sessions] = await Promise.all([
          loadJson("/ops/overview"),
          loadJson("/ops/runtime"),
          loadJson("/ops/runs?status=error&limit=5"),
          loadJson("/ops/runs?status=canceled&limit=5"),
          loadJson("/ops/runs?limit=50"),
          loadJson("/ops/sessions"),
        ]);
        const activeRuns = runtime.activeRuns.filter(run => run.status !== "canceling");
        const cancelingRuns = runtime.activeRuns.filter(run => run.status === "canceling");
        const visibleRunIds = new Set([
          ...activeRuns.map(run => run.runId),
          ...runtime.queuedRuns.map(run => run.runId),
          ...cancelingRuns.map(run => run.runId),
          ...failedRuns.map(run => run.runId),
          ...canceledRuns.map(run => run.runId),
        ]);
        const historyRuns = runs.filter(run => !visibleRunIds.has(run.runId));
        const selectionCandidates = [
          ...activeRuns,
          ...runtime.queuedRuns,
          ...cancelingRuns,
          ...failedRuns,
          ...canceledRuns,
          ...historyRuns,
        ];

        renderOverview(overview);
        renderRuntime(runtime);
        renderIncidents(failedRuns, canceledRuns);
        renderRuns(historyRuns);
        renderSessions(sessions);
        attachRunInteractions();

        if (!state.selectedRunId && selectionCandidates[0]) {
          state.selectedRunId = selectionCandidates[0].runId;
        }

        if (state.selectedRunId) {
          await loadRunDetail(state.selectedRunId);
        } else {
          document.getElementById("detail").innerHTML = '<p class="subtle">暂无任务记录。</p>';
        }
      }

      function renderOverview(overview) {
        document.getElementById("overview").innerHTML = [
          ["活跃任务", overview.activeRuns],
          ["排队任务", overview.queuedRuns],
          ["取消中", overview.cancelingRuns],
          ["最近失败", overview.latestError || "无"],
          ["最近取消", overview.latestCancel || "无"],
        ].map(([label, value]) => \`
          <article class="card">
            <span class="subtle">\${escapeHtml(label)}</span>
            <strong>\${escapeHtml(value)}</strong>
          </article>
        \`).join("");
      }

      function renderRuntime(runtime) {
        const activeRuns = runtime.activeRuns.filter(run => run.status !== "canceling");
        const cancelingRuns = runtime.activeRuns.filter(run => run.status === "canceling");
        const activeMarkup = renderRunCards(activeRuns, { selectable: true, showCancel: true });
        const cancelingMarkup = renderRunCards(cancelingRuns, { selectable: true, showCancel: false });
        const queuedMarkup = renderRunCards(runtime.queuedRuns, { selectable: true, showCancel: true });

        document.getElementById("runtime-meta").textContent =
          "活跃 " + runtime.activeCount + " / 排队 " + runtime.queuedCount + " / 取消中 " + runtime.cancelingCount + " / 锁 " + runtime.locks.length;
        document.getElementById("runtime").innerHTML =
          buildSectionBlock("活跃任务", "优先处理正在消耗资源的任务", activeMarkup || '<p class="subtle">暂无活跃任务。</p>') +
          buildSectionBlock("排队任务", "关注是否出现堆积", queuedMarkup || '<p class="subtle">暂无排队任务。</p>') +
          buildSectionBlock("取消中", "确认停止请求是否正在收口", cancelingMarkup || '<p class="subtle">暂无取消中的任务。</p>');
      }

      function renderIncidents(failedRuns, canceledRuns) {
        const failedMarkup = renderRunCards(failedRuns, { selectable: true, showCancel: false });
        const canceledMarkup = renderRunCards(canceledRuns, { selectable: true, showCancel: false });
        document.getElementById("incidents").innerHTML =
          buildSectionBlock("最近失败", "先看最近失败的 root cause", failedMarkup || '<p class="subtle">最近没有失败任务。</p>') +
          buildSectionBlock("最近取消", "确认取消是否符合预期", canceledMarkup || '<p class="subtle">最近没有取消任务。</p>');
      }

      function renderRuns(runs) {
        const historyMarkup = renderRunCards(runs, { selectable: true, showCancel: false });
        document.getElementById("runs").innerHTML =
          buildSectionBlock("其他历史任务（次级）", "保留次级历史入口，便于继续钻取详情", historyMarkup || '<p class="subtle">暂无其他历史任务。</p>');
      }

      function renderSessions(sessions) {
        document.getElementById("sessions").innerHTML =
          buildSectionBlock("会话快照（次级）", "用于排障，不作为首屏主决策区", sessions.map(session => \`
          <div class="session-row">
            <div>
              <div><strong>\${escapeHtml(session.peerId)}</strong> <span class="subtle">/</span> <code>\${escapeHtml(session.sessionName)}</code></div>
              <div class="muted-line">latest=\${escapeHtml(session.latestRunId || "-")} | stage=\${escapeHtml(formatStageLabel(session.latestRunStage))}</div>
            </div>
            <span class="\${statusBadgeClass(session.latestRunStatus || "queued")}">\${escapeHtml(formatStatusLabel(session.latestRunStatus || "idle"))}</span>
          </div>
        \`).join("") || '<p class="subtle">暂无会话快照。</p>');
      }

      async function loadRunDetail(runId) {
        const payload = await loadJson("/ops/runs/" + encodeURIComponent(runId));
        renderRunDetail(payload.run, payload.events);
      }

      async function cancelRun(runId) {
        const response = await fetch("/ops/runs/" + encodeURIComponent(runId) + "/cancel", {
          method: "POST",
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error("cancel failed: " + response.status);
        }
        await refreshDashboard();
      }

      function renderRunDetail(run, events) {
        document.getElementById("detail-meta").textContent =
          formatStatusLabel(run.status) + " / " + formatStageLabel(run.stage) + " | " + run.runId;
        document.getElementById("detail").innerHTML = \`
          <div class="detail-section">
            <div class="detail-grid">
              <div class="kv"><label>状态</label><div><span class="\${statusBadgeClass(run.status)}">\${renderStatusPair(run.status, run.stage)}</span></div></div>
              <div class="kv"><label>项目</label><div><code>\${escapeHtml(run.projectId || "-")}</code></div></div>
              <div class="kv"><label>Codex 线程 ID</label><div><code>\${escapeHtml(run.threadId || "-")}</code></div></div>
              <div class="kv"><label>开始时间</label><div>\${escapeHtml(run.startedAt || "-")}</div></div>
              <div class="kv"><label>更新时间</label><div>\${escapeHtml(run.updatedAt || "-")}</div></div>
              <div class="kv"><label>结束时间</label><div>\${escapeHtml(run.finishedAt || "-")}</div></div>
            </div>
          </div>
          <div class="kv detail-section">
            <label>最近公开进展</label>
            <div>\${escapeHtml(run.latestPreview || "-")}</div>
          </div>
          <div class="detail-section">
            <h3 class="section-title" style="margin-bottom: 10px;">技术元数据</h3>
            <div class="detail-grid">
              <div class="kv"><label>会话</label><div><code>\${escapeHtml(run.sessionName)}</code></div></div>
              <div class="kv"><label>Peer</label><div>\${escapeHtml(run.peerId)}</div></div>
              <div class="kv"><label>Root</label><div><code>\${escapeHtml(run.rootId)}</code></div></div>
              <div class="kv"><label>最近工具</label><div><code>\${escapeHtml(run.latestTool || "-")}</code></div></div>
              <div class="kv"><label>投递 Chat</label><div><code>\${escapeHtml(run.deliveryChatId || "-")}</code></div></div>
              <div class="kv"><label>投递 Surface</label><div><code>\${escapeHtml(run.deliverySurfaceType || "-")} / \${escapeHtml(run.deliverySurfaceRef || "-")}</code></div></div>
              <div class="kv"><label>取消请求</label><div>\${escapeHtml(run.cancelRequestedAt || "-")}</div></div>
              <div class="kv"><label>取消来源</label><div><code>\${escapeHtml(run.cancelRequestedBy || run.cancelSource || "-")}</code></div></div>
            </div>
          </div>
          <div class="detail-section">
            <h3 class="section-title" style="margin-bottom: 10px;">时间线</h3>
            <div class="timeline">
            \${events.map(event => \`
              <div class="event">
                <div class="event-top">
                  <strong>\${escapeHtml(event.seq)}. \${escapeHtml(event.source)} / \${escapeHtml(formatStageLabel(event.stage))}</strong>
                  <span class="\${statusBadgeClass(event.status)}">\${escapeHtml(formatStatusLabel(event.status))}</span>
                </div>
                <div class="muted-line">\${escapeHtml(event.createdAt)} | tool=\${escapeHtml(event.toolName || "-")}</div>
                <div>\${escapeHtml(event.preview)}</div>
              </div>
            \`).join("")}
            </div>
          </div>
        \`;
      }

      function buildSectionBlock(title, note, body) {
        return \`
          <section class="section-block">
            <div class="section-header">
              <div class="section-title">\${escapeHtml(title)}</div>
              <div class="section-note">\${escapeHtml(note)}</div>
            </div>
            <div class="runs">\${body}</div>
          </section>
        \`;
      }

      function renderRunCards(runs, options) {
        return runs.map(run => \`
          <article class="run \${options.selectable ? "selectable" : ""} \${options.selectable && state.selectedRunId === run.runId ? "active" : ""}" \${options.selectable ? \`data-run-id="\${escapeHtml(run.runId)}"\` : ""}>
            <div class="run-top">
              <span class="\${statusBadgeClass(run.status)}">\${renderStatusPair(run.status, run.stage)}</span>
              <div>
                <div><strong>\${escapeHtml(run.peerId)}</strong> <span class="subtle">via</span> <code>\${escapeHtml(run.sessionName)}</code></div>
                <div class="muted-line">project=\${escapeHtml(run.projectId || "-")} | thread=\${escapeHtml(run.threadId || "-")}</div>
                <div class="muted-line">\${escapeHtml(run.latestPreview)}</div>
              </div>
            </div>
            <div class="muted-line">run=\${escapeHtml(run.runId)} | started=\${escapeHtml(run.startedAt || "-")} | updated=\${escapeHtml(run.updatedAt || "-")}\${Number.isFinite(run.waitMs) ? \` | wait=\${escapeHtml(run.waitMs)}ms\` : ""}</div>
            \${options.showCancel ? \`
              <div class="muted-line">
                \${run.cancelable ? \`<button type="button" class="cancel-run" data-run-id="\${escapeHtml(run.runId)}">取消</button>\` : '<span class="subtle">不可取消</span>'}
              </div>
            \` : ""}
          </article>
        \`).join("");
      }

      function attachRunInteractions() {
        for (const element of document.querySelectorAll(".run.selectable[data-run-id]")) {
          element.addEventListener("click", async () => {
            state.selectedRunId = element.getAttribute("data-run-id");
            await refreshDashboard().catch(showError);
          });
        }

        for (const element of document.querySelectorAll(".cancel-run")) {
          element.addEventListener("click", async event => {
            event.stopPropagation();
            const runId = element.getAttribute("data-run-id");
            if (!runId) return;
            await cancelRun(runId).catch(showError);
          });
        }
      }

      document.getElementById("refresh").addEventListener("click", () => {
        refreshDashboard().catch(showError);
      });

      function showError(error) {
        document.getElementById("detail").innerHTML = '<p class="subtle">加载失败：' + escapeHtml(error.message || error) + '</p>';
      }

      refreshDashboard().catch(showError);
      setInterval(() => {
        refreshDashboard().catch(showError);
      }, 5000);
    </script>
  </body>
</html>`;
}
