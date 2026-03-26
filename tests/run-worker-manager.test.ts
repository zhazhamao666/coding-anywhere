import { describe, expect, it } from "vitest";

import { RunWorkerManager } from "../src/run-worker-manager.js";

describe("RunWorkerManager", () => {
  it("enforces the global concurrency limit", async () => {
    const manager = new RunWorkerManager({ maxConcurrentRuns: 1 });
    const started: string[] = [];

    const runA = manager.schedule("thread-a", async () => {
      started.push("a");
      await Promise.resolve();
    });

    const runB = manager.schedule("thread-b", async () => {
      started.push("b");
    });

    await runA;
    await runB;

    expect(started).toEqual(["a", "b"]);
  });
});
