import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

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
        listRuns: async () => ([
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
        ]),
        getRun: async () => ({
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
    expect(ui.body).toContain("取消");
    expect(ui.body).toContain("Backend Observability");
  });
});
