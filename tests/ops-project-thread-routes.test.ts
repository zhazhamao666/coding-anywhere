import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("/ops thread routes", () => {
  it("exposes thread summaries and run history", async () => {
    const app = buildApp({
      observability: {
        getOverview: async () => ({
          activeRuns: 1,
          totalRuns: 2,
          completedRuns24h: 1,
          failedRuns24h: 0,
          latestError: null,
          updatedAt: "2026-03-24T10:00:00.000Z",
        }),
        listRuns: async () => [],
        getRun: async () => undefined,
        listRunEvents: async () => [],
        listSessionSnapshots: async () => [],
        listProjects: async () => ([
          {
            projectId: "proj-a",
            name: "coding-anywhere",
            chatId: "oc_chat_1",
            threadCount: 1,
            runningThreadCount: 1,
            updatedAt: "2026-03-24T10:00:00.000Z",
          },
        ]),
        listProjectThreads: async () => ([
          {
            threadId: "thread-a",
            projectId: "proj-a",
            title: "feishu-nav",
            sessionName: "codex-proj-a-thread-a",
            status: "running",
            ownerOpenId: "ou_user",
            updatedAt: "2026-03-24T10:00:00.000Z",
            lastRunId: "run-1",
          },
        ]),
        getThread: async () => ({
          threadId: "thread-a",
          projectId: "proj-a",
          title: "feishu-nav",
          sessionName: "codex-proj-a-thread-a",
          status: "running",
          ownerOpenId: "ou_user",
          updatedAt: "2026-03-24T10:00:00.000Z",
          lastRunId: "run-1",
        }),
        listThreadRuns: async () => ([
          {
            runId: "run-1",
            channel: "feishu",
            peerId: "ou_user",
            projectId: "proj-a",
            threadId: "thread-a",
            deliveryChatId: "oc_chat_1",
            deliverySurfaceType: "thread",
            deliverySurfaceRef: "omt_1",
            sessionName: "codex-proj-a-thread-a",
            rootId: "main",
            status: "running",
            stage: "tool_call",
            latestPreview: "npm test",
            latestTool: "npm test",
            errorText: null,
            startedAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:05.000Z",
            finishedAt: null,
          },
        ]),
      } as any,
    });

    const projects = await app.inject({ method: "GET", url: "/ops/projects" });
    const threads = await app.inject({ method: "GET", url: "/ops/projects/proj-a/threads" });
    const thread = await app.inject({ method: "GET", url: "/ops/threads/thread-a" });
    const runs = await app.inject({ method: "GET", url: "/ops/threads/thread-a/runs" });

    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toEqual([
      expect.objectContaining({
        projectId: "proj-a",
        threadCount: 1,
      }),
    ]);
    expect(threads.statusCode).toBe(200);
    expect(threads.json()).toEqual([
      expect.objectContaining({
        threadId: "thread-a",
        status: "running",
      }),
    ]);
    expect(thread.statusCode).toBe(200);
    expect(thread.json()).toEqual(
      expect.objectContaining({
        threadId: "thread-a",
        lastRunId: "run-1",
      }),
    );
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual([
      expect.objectContaining({
        runId: "run-1",
        threadId: "thread-a",
      }),
    ]);
  });
});
