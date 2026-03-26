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
          totalRuns: 3,
          completedRuns24h: 2,
          failedRuns24h: 1,
          latestError: "RUN_STREAM_FAILED",
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
      },
    });

    const overview = await app.inject({ method: "GET", url: "/ops/overview" });
    const runs = await app.inject({ method: "GET", url: "/ops/runs?limit=10" });
    const runDetail = await app.inject({ method: "GET", url: "/ops/runs/run-1" });
    const sessions = await app.inject({ method: "GET", url: "/ops/sessions" });
    const ui = await app.inject({ method: "GET", url: "/ops/ui" });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      activeRuns: 1,
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
    expect(ui.body).toContain("Backend Observability");
  });
});
