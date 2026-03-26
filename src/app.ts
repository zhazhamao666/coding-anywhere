import Fastify from "fastify";

import { createMetricsRegistry } from "./ops.js";
import type {
  ListRunsFilters,
  ObservabilityOverview,
  ObservabilityProjectSummary,
  ObservabilityRun,
  ObservabilityRunEvent,
  ObservabilityThreadSummary,
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
        limit?: string;
      };

      return observability.listRuns({
        status: query.status,
        peerId: query.peer_id,
        sessionName: query.session_name,
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

      .runs {
        display: grid;
        gap: 10px;
      }

      .run {
        border: 1px solid transparent;
        border-radius: 14px;
        padding: 14px;
        background: #f8faff;
        cursor: pointer;
      }

      .run.active {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .run:hover {
        border-color: #8fb6ff;
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
        <p class="subtle">任务级后台观测页面，核心数据来源于 <code>/ops/overview</code>、<code>/ops/runs</code>、<code>/ops/runs/:id</code>、<code>/ops/sessions</code>，项目与线程补充视图可通过 <code>/ops/projects</code> 与 <code>/ops/threads/:id</code> 获取。</p>
      </div>

      <section class="overview" id="overview"></section>

      <section class="layout">
        <div class="panel">
          <header>
            <div>
              <h2>最近任务</h2>
              <div class="subtle" id="runs-meta">加载中...</div>
            </div>
            <button id="refresh" type="button">刷新</button>
          </header>
          <div class="panel-body">
            <div class="runs" id="runs"></div>
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

      function statusBadgeClass(status) {
        if (status === "error") return "badge error";
        if (status === "tool_active") return "badge tool_active";
        return "badge";
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
        const [overview, runs, sessions] = await Promise.all([
          loadJson("/ops/overview"),
          loadJson("/ops/runs?limit=50"),
          loadJson("/ops/sessions"),
        ]);

        renderOverview(overview);
        renderRuns(runs);
        renderSessions(sessions);

        if (!state.selectedRunId && runs[0]) {
          state.selectedRunId = runs[0].runId;
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
          ["总任务数", overview.totalRuns],
          ["24h 完成", overview.completedRuns24h],
          ["24h 失败", overview.failedRuns24h],
          ["最近错误", overview.latestError || "无"],
          ["最近更新", overview.updatedAt || "无"],
        ].map(([label, value]) => \`
          <article class="card">
            <span class="subtle">\${escapeHtml(label)}</span>
            <strong>\${escapeHtml(value)}</strong>
          </article>
        \`).join("");
      }

      function renderRuns(runs) {
        document.getElementById("runs-meta").textContent = "共 " + runs.length + " 条，默认按活跃优先";
        document.getElementById("runs").innerHTML = runs.map(run => \`
          <article class="run \${state.selectedRunId === run.runId ? "active" : ""}" data-run-id="\${escapeHtml(run.runId)}">
            <div class="run-top">
              <span class="\${statusBadgeClass(run.status)}">\${escapeHtml(run.status)} / \${escapeHtml(run.stage)}</span>
              <div>
                <div><strong>\${escapeHtml(run.peerId)}</strong> <span class="subtle">via</span> <code>\${escapeHtml(run.sessionName)}</code></div>
                <div class="muted-line">project=\${escapeHtml(run.projectId || "-")} | thread=\${escapeHtml(run.threadId || "-")}</div>
                <div class="muted-line">\${escapeHtml(run.latestPreview)}</div>
              </div>
            </div>
            <div class="muted-line">run=\${escapeHtml(run.runId)} | tool=\${escapeHtml(run.latestTool || "-")} | updated=\${escapeHtml(run.updatedAt)}</div>
          </article>
        \`).join("");

        for (const element of document.querySelectorAll(".run")) {
          element.addEventListener("click", async () => {
            state.selectedRunId = element.getAttribute("data-run-id");
            renderRuns(runs);
            if (state.selectedRunId) {
              await loadRunDetail(state.selectedRunId);
            }
          });
        }
      }

      function renderSessions(sessions) {
        document.getElementById("sessions").innerHTML = '<h2>会话快照</h2>' + sessions.map(session => \`
          <div class="session-row">
            <div>
              <div><strong>\${escapeHtml(session.peerId)}</strong> <span class="subtle">/</span> <code>\${escapeHtml(session.sessionName)}</code></div>
              <div class="muted-line">latest=\${escapeHtml(session.latestRunId || "-")} | stage=\${escapeHtml(session.latestRunStage || "-")}</div>
            </div>
            <span class="\${statusBadgeClass(session.latestRunStatus || "queued")}">\${escapeHtml(session.latestRunStatus || "idle")}</span>
          </div>
        \`).join("");
      }

      async function loadRunDetail(runId) {
        const payload = await loadJson("/ops/runs/" + encodeURIComponent(runId));
        renderRunDetail(payload.run, payload.events);
      }

      function renderRunDetail(run, events) {
        document.getElementById("detail-meta").textContent = run.runId + " | " + run.updatedAt;
        document.getElementById("detail").innerHTML = \`
          <div class="detail-grid">
            <div class="kv"><label>Peer</label><div>\${escapeHtml(run.peerId)}</div></div>
            <div class="kv"><label>Project</label><div><code>\${escapeHtml(run.projectId || "-")}</code></div></div>
            <div class="kv"><label>Thread</label><div><code>\${escapeHtml(run.threadId || "-")}</code></div></div>
            <div class="kv"><label>Session</label><div><code>\${escapeHtml(run.sessionName)}</code></div></div>
            <div class="kv"><label>Root</label><div><code>\${escapeHtml(run.rootId)}</code></div></div>
            <div class="kv"><label>状态</label><div><span class="\${statusBadgeClass(run.status)}">\${escapeHtml(run.status)} / \${escapeHtml(run.stage)}</span></div></div>
            <div class="kv"><label>最近工具</label><div><code>\${escapeHtml(run.latestTool || "-")}</code></div></div>
            <div class="kv"><label>投递 Chat</label><div><code>\${escapeHtml(run.deliveryChatId || "-")}</code></div></div>
            <div class="kv"><label>投递 Surface</label><div><code>\${escapeHtml(run.deliverySurfaceType || "-")} / \${escapeHtml(run.deliverySurfaceRef || "-")}</code></div></div>
            <div class="kv"><label>结束时间</label><div>\${escapeHtml(run.finishedAt || "-")}</div></div>
          </div>
          <div class="kv" style="margin-bottom: 16px;">
            <label>最新预览</label>
            <div>\${escapeHtml(run.latestPreview)}</div>
          </div>
          <div class="timeline">
            \${events.map(event => \`
              <div class="event">
                <div class="event-top">
                  <strong>\${escapeHtml(event.seq)}. \${escapeHtml(event.source)} / \${escapeHtml(event.stage)}</strong>
                  <span class="\${statusBadgeClass(event.status)}">\${escapeHtml(event.status)}</span>
                </div>
                <div class="muted-line">\${escapeHtml(event.createdAt)} | tool=\${escapeHtml(event.toolName || "-")}</div>
                <div>\${escapeHtml(event.preview)}</div>
              </div>
            \`).join("")}
          </div>
        \`;
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
