import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ListRunsFilters, ObservabilityRun } from "../src/types.js";

describe("buildApp", () => {
  it("serves health and readiness endpoints", async () => {
    const app = buildApp();

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
  });

  it("serves backend observability JSON endpoints and local ops UI", async () => {
    const listRunsMock = vi.fn(async (filters: ListRunsFilters): Promise<ObservabilityRun[]> => {
      if (filters.status === "error") {
        return [
          {
            runId: "run-error",
            channel: "feishu",
            peerId: "ou_error",
            projectId: "proj-error",
            threadId: "thread-error",
            deliveryChatId: null,
            deliverySurfaceType: null,
            deliverySurfaceRef: null,
            sessionName: "codex-error",
            rootId: "main",
            status: "error",
            stage: "error",
            latestPreview: "任务失败：API 超时",
            latestTool: "npm test",
            errorText: "API timeout",
            cancelRequestedAt: null,
            cancelRequestedBy: null,
            cancelSource: null,
            startedAt: "2026-03-23T10:05:00.000Z",
            updatedAt: "2026-03-23T10:06:00.000Z",
            finishedAt: "2026-03-23T10:06:00.000Z",
          },
        ];
      }

      if (filters.status === "canceled") {
        return [
          {
            runId: "run-canceled",
            channel: "feishu",
            peerId: "ou_cancel",
            projectId: "proj-cancel",
            threadId: "thread-cancel",
            deliveryChatId: null,
            deliverySurfaceType: null,
            deliverySurfaceRef: null,
            sessionName: "codex-cancel",
            rootId: "main",
            status: "canceled",
            stage: "canceled",
            latestPreview: "任务已按请求停止",
            latestTool: null,
            errorText: null,
            cancelRequestedAt: "2026-03-23T10:07:00.000Z",
            cancelRequestedBy: "ops",
            cancelSource: "ops",
            startedAt: "2026-03-23T10:06:00.000Z",
            updatedAt: "2026-03-23T10:07:05.000Z",
            finishedAt: "2026-03-23T10:07:05.000Z",
          },
        ];
      }

      return [
        {
          runId: "run-1",
          channel: "feishu",
          peerId: "ou_demo",
          projectId: null,
          threadId: null,
          deliveryChatId: null,
          deliverySurfaceType: null,
          deliverySurfaceRef: null,
          sessionName: "codex-main",
          rootId: "main",
          status: "running",
          stage: "tool_call",
          latestPreview: "[ca] tool_call: npm test",
          latestTool: "npm test",
          errorText: null,
          cancelRequestedAt: null,
          cancelRequestedBy: null,
          cancelSource: null,
          startedAt: "2026-03-23T10:00:00.000Z",
          updatedAt: "2026-03-23T10:00:10.000Z",
          finishedAt: null,
        },
      ];
    });

    const app = buildApp({
      observability: {
        getOverview: async () => ({
          activeRuns: 1,
          queuedRuns: 1,
          cancelingRuns: 0,
          totalRuns: 3,
          completedRuns24h: 2,
          failedRuns24h: 1,
          longestActiveMs: 2_000,
          longestQueuedMs: 1_000,
          latestError: "RUN_STREAM_FAILED",
          latestCancel: "ops @ 2026-03-23T10:00:05.000Z",
          updatedAt: "2026-03-23T10:00:00.000Z",
        }),
        listRuns: listRunsMock,
        getRun: async () => ({
          runId: "run-1",
          channel: "feishu",
          peerId: "ou_demo",
          projectId: "proj-a",
          threadId: "thread-a",
          deliveryChatId: "oc_chat_a",
          deliverySurfaceType: "thread",
          deliverySurfaceRef: "omt_a",
          sessionName: "codex-main",
          rootId: "main",
          status: "running",
          stage: "tool_call",
          latestPreview: "[ca] tool_call: npm test",
          latestTool: "npm test",
          startedAt: "2026-03-23T10:00:00.000Z",
          updatedAt: "2026-03-23T10:00:10.000Z",
          finishedAt: null,
          errorText: null,
          cancelRequestedAt: null,
          cancelRequestedBy: null,
          cancelSource: null,
        }),
        listRunEvents: async () => ([
          {
            runId: "run-1",
            seq: 1,
            source: "bridge",
            status: "queued",
            stage: "received",
            preview: "[ca] received",
            toolName: null,
            createdAt: "2026-03-23T10:00:00.000Z",
          },
        ]),
        listSessionSnapshots: async () => ([
          {
            channel: "feishu",
            peerId: "ou_demo",
            sessionName: "codex-main",
            latestRunId: "run-1",
            latestRunStatus: "running",
            latestRunStage: "tool_call",
            updatedAt: "2026-03-23T10:00:10.000Z",
          },
        ]),
        getRuntimeSnapshot: async () => ({
          maxConcurrentRuns: 3,
          activeCount: 1,
          queuedCount: 1,
          cancelingCount: 0,
          locks: ["thread-a"],
          activeRuns: [
            {
              runId: "run-1",
              concurrencyKey: "thread-a",
              channel: "feishu",
              peerId: "ou_demo",
              projectId: "proj-a",
              threadId: "thread-a",
              deliveryChatId: "oc_chat_a",
              deliverySurfaceType: "thread",
              deliverySurfaceRef: "omt_a",
              sessionName: "thread-a",
              rootId: "main",
              model: null,
              reasoningEffort: null,
              speed: null,
              status: "running",
              stage: "tool_call",
              latestPreview: "[ca] tool_call: npm test",
              latestTool: "npm test",
              startedAt: "2026-03-23T10:00:00.000Z",
              waitMs: 10,
              elapsedMs: 10,
              cancelable: true,
            },
          ],
          queuedRuns: [
            {
              runId: "run-2",
              concurrencyKey: "thread-b",
              channel: "feishu",
              peerId: "ou_demo",
              projectId: "proj-b",
              threadId: "thread-b",
              deliveryChatId: "oc_chat_b",
              deliverySurfaceType: "thread",
              deliverySurfaceRef: "omt_b",
              sessionName: "thread-b",
              rootId: "main",
              model: null,
              reasoningEffort: null,
              speed: null,
              status: "queued",
              stage: "received",
              latestPreview: "[ca] received",
              latestTool: null,
              startedAt: "2026-03-23T10:00:01.000Z",
              waitMs: 20,
              elapsedMs: 20,
              cancelable: true,
            },
          ],
        }),
        cancelRun: vi.fn(async () => ({
          accepted: true,
          runId: "run-1",
          newStatus: "canceling",
          message: "cancel requested",
        })),
      },
    });

    const overview = await app.inject({ method: "GET", url: "/ops/overview" });
    const runs = await app.inject({ method: "GET", url: "/ops/runs?limit=10" });
    const errorRuns = await app.inject({ method: "GET", url: "/ops/runs?status=error&limit=5" });
    const canceledRuns = await app.inject({ method: "GET", url: "/ops/runs?status=canceled&limit=5" });
    const runDetail = await app.inject({ method: "GET", url: "/ops/runs/run-1" });
    const runtime = await app.inject({ method: "GET", url: "/ops/runtime" });
    const cancel = await app.inject({ method: "POST", url: "/ops/runs/run-1/cancel" });
    const sessions = await app.inject({ method: "GET", url: "/ops/sessions" });
    const ui = await app.inject({ method: "GET", url: "/ops/ui" });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      activeRuns: 1,
      queuedRuns: 1,
      failedRuns24h: 1,
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual([
      expect.objectContaining({
        runId: "run-1",
        latestTool: "npm test",
      }),
    ]);
    expect(errorRuns.statusCode).toBe(200);
    expect(errorRuns.json()).toEqual([
      expect.objectContaining({
        runId: "run-error",
        status: "error",
      }),
    ]);
    expect(canceledRuns.statusCode).toBe(200);
    expect(canceledRuns.json()).toEqual([
      expect.objectContaining({
        runId: "run-canceled",
        status: "canceled",
      }),
    ]);
    expect(runDetail.statusCode).toBe(200);
    expect(runDetail.json()).toEqual(
      expect.objectContaining({
        run: expect.objectContaining({
          runId: "run-1",
        }),
        events: [
          expect.objectContaining({
            seq: 1,
            stage: "received",
          }),
        ],
      }),
    );
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json()).toMatchObject({
      activeCount: 1,
      queuedCount: 1,
      locks: ["thread-a"],
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({
      accepted: true,
      runId: "run-1",
      newStatus: "canceling",
      message: "cancel requested",
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual([
      expect.objectContaining({
        peerId: "ou_demo",
        latestRunStatus: "running",
      }),
    ]);
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
    expect(ui.body).toContain("/ops/overview");
    expect(ui.body).toContain("/ops/runtime");
    expect(ui.body).toContain("/ops/runs?status=error&limit=5");
    expect(ui.body).toContain("/ops/runs?status=canceled&limit=5");
    expect(ui.body).toContain("取消");
    expect(ui.body).toContain("Backend Observability");
    expect(ui.body).toContain("最近失败");
    expect(ui.body).toContain("最近取消");
    expect(ui.body).toContain("取消中");
    expect(ui.body).toContain("其他历史任务（次级）");
    expect(ui.body).toContain("开始时间");
    expect(ui.body).toContain("最近公开进展");
    expect(ui.body).toContain("技术元数据");
    expect(ui.body).toContain("<label>Codex 线程 ID</label>");
    expect(ui.body).not.toContain("<label>线程</label>");
    expect(ui.body).toContain("会话快照（次级）");
    expect(ui.body).toContain('"running":"运行中"');
    expect(ui.body).toContain('"tool_call":"工具调用"');
    expect(ui.body).toContain('"queued":"排队中"');
    expect(ui.body).toContain('"received":"已接收"');
    expect(ui.body).not.toContain("默认按最近更新时间倒序");
    expect(ui.body.indexOf("<label>状态</label>")).toBeLessThan(ui.body.indexOf("<label>Root</label>"));
    expect(ui.body.indexOf("<label>最近公开进展</label>")).toBeLessThan(ui.body.indexOf("<label>Root</label>"));
    expect(ui.body.indexOf("最近失败")).toBeLessThan(ui.body.indexOf("其他历史任务（次级）"));
    expect(ui.body.indexOf("其他历史任务（次级）")).toBeLessThan(ui.body.indexOf("会话快照（次级）"));
  });
});
