import { describe, expect, it, vi } from "vitest";

import { RunWorkerManager } from "../src/run-worker-manager.js";

describe("RunWorkerManager", () => {
  it("enforces the global concurrency limit", async () => {
    const manager = new RunWorkerManager({ maxConcurrentRuns: 1 });
    const started: string[] = [];

    const runA = manager.schedule({
      runId: "run-a",
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
      latestPreview: "[ca] received",
    }, async () => {
      started.push("a");
      await Promise.resolve();
    });

    const runB = manager.schedule({
      runId: "run-b",
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
      latestPreview: "[ca] received",
    }, async () => {
      started.push("b");
    });

    await runA;
    await runB;

    expect(started).toEqual(["a", "b"]);
  });

  it("cancels a queued run before it starts and removes it from runtime snapshots", async () => {
    const manager = new RunWorkerManager({ maxConcurrentRuns: 1 });
    let releaseActive: (() => void) | undefined;

    const runA = manager.schedule({
      runId: "run-a",
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
      latestPreview: "[ca] received",
    }, async () => {
      await new Promise<void>(resolve => {
        releaseActive = resolve;
      });
    });

    const runB = manager.schedule({
      runId: "run-b",
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
      latestPreview: "[ca] received",
    }, async () => undefined);

    await Promise.resolve();

    expect(manager.getRuntimeSnapshot()).toMatchObject({
      activeCount: 1,
      queuedCount: 1,
      activeRuns: [
        expect.objectContaining({
          runId: "run-a",
          cancelable: true,
        }),
      ],
      queuedRuns: [
        expect.objectContaining({
          runId: "run-b",
          cancelable: true,
        }),
      ],
    });

    await expect(manager.cancelRun("run-b")).resolves.toEqual({
      accepted: true,
      runId: "run-b",
      newStatus: "canceled",
      message: "run canceled",
    });
    await expect(runB).rejects.toThrow("RUN_CANCELED");

    expect(manager.getRuntimeSnapshot()).toMatchObject({
      activeCount: 1,
      queuedCount: 0,
      queuedRuns: [],
    });

    releaseActive?.();
    await runA;
  });

  it("requests cancellation for an active run and marks it as canceling in runtime snapshots", async () => {
    const manager = new RunWorkerManager({ maxConcurrentRuns: 1 });
    const canceler = vi.fn(async () => undefined);
    let rejectRun: ((error: Error) => void) | undefined;

    const runA = manager.schedule({
      runId: "run-a",
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
      latestPreview: "[ca] received",
    }, async control => {
      control.setCanceler(canceler);
      return await new Promise((_resolve, reject) => {
        rejectRun = reject as (error: Error) => void;
      });
    });

    await Promise.resolve();
    manager.updateRunProgress("run-a", {
      status: "running",
      stage: "text",
      latestPreview: "still working",
      latestTool: "npm test",
    });

    await expect(manager.cancelRun("run-a")).resolves.toEqual({
      accepted: true,
      runId: "run-a",
      newStatus: "canceling",
      message: "cancel requested",
    });

    expect(canceler).toHaveBeenCalledTimes(1);
    expect(manager.getRuntimeSnapshot()).toMatchObject({
      activeCount: 1,
      cancelingCount: 1,
      locks: ["thread-a"],
      activeRuns: [
        expect.objectContaining({
          runId: "run-a",
          status: "canceling",
          stage: "canceling",
          latestTool: "npm test",
          cancelable: false,
        }),
      ],
    });
    expect(manager.getCurrentRun("thread-a")).toMatchObject({
      runId: "run-a",
      status: "canceling",
    });

    rejectRun?.(new Error("RUN_CANCELED"));
    await expect(runA).rejects.toThrow("RUN_CANCELED");
    expect(manager.getRuntimeSnapshot()).toMatchObject({
      activeCount: 0,
      cancelingCount: 0,
    });
  });

  it("rebinds an active run to the materialized thread key", async () => {
    const manager = new RunWorkerManager({ maxConcurrentRuns: 1 });
    let releaseRun: (() => void) | undefined;

    const run = manager.schedule({
      runId: "run-a",
      concurrencyKey: "pending:feishu:ou_demo",
      channel: "feishu",
      peerId: "ou_demo",
      projectId: null,
      threadId: null,
      deliveryChatId: null,
      deliverySurfaceType: null,
      deliverySurfaceRef: null,
      sessionName: "codex-main",
      rootId: "main",
      latestPreview: "[ca] received",
    }, async () => {
      await new Promise<void>(resolve => {
        releaseRun = resolve;
      });
    });

    await Promise.resolve();

    manager.rebindRun("run-a", {
      concurrencyKey: "codex-thread:thread-created",
      projectId: "proj-created",
      threadId: "thread-created",
      sessionName: "thread-created",
    });

    expect(manager.getCurrentRun("pending:feishu:ou_demo")).toBeUndefined();
    expect(manager.getCurrentRun("codex-thread:thread-created")).toMatchObject({
      runId: "run-a",
      concurrencyKey: "codex-thread:thread-created",
      projectId: "proj-created",
      threadId: "thread-created",
      sessionName: "thread-created",
    });
    expect(manager.getRuntimeSnapshot()).toMatchObject({
      locks: ["codex-thread:thread-created"],
      activeRuns: [
        expect.objectContaining({
          runId: "run-a",
          concurrencyKey: "codex-thread:thread-created",
        }),
      ],
    });

    releaseRun?.();
    await run;
  });
});
