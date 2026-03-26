import { describe, expect, it } from "vitest";

import { ThreadRunGuard } from "../src/thread-run-guard.js";

describe("ThreadRunGuard", () => {
  it("allows one active run per thread", () => {
    const guard = new ThreadRunGuard();

    expect(guard.tryAcquire("thread-a")).toBe(true);
    expect(guard.tryAcquire("thread-a")).toBe(false);

    guard.release("thread-a");

    expect(guard.tryAcquire("thread-a")).toBe(true);
  });
});
