import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reapIdleThreads } from "../src/runtime.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("thread idle reaping", () => {
  let rootDir: string;
  let store: SessionStore;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "thread-reap-"));
    store = new SessionStore(path.join(rootDir, "bridge.db"));
    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: "D:/root",
      repoRoot: "D:/root",
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });
    store.createProject({
      projectId: "proj-a",
      name: "coding-anywhere",
      cwd: "D:/repo",
      repoRoot: "D:/repo",
    });
    store.createCodexThread({
      threadId: "thread-a",
      projectId: "proj-a",
      feishuThreadId: "omt_1",
      chatId: "oc_chat_1",
      anchorMessageId: "om_anchor",
      latestMessageId: "om_anchor",
      sessionName: "codex-proj-a-thread-a",
      title: "feishu-nav",
      ownerOpenId: "ou_user",
      status: "warm",
      lastActivityAt: "2026-03-20T00:00:00.000Z",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("marks warm threads closed after the configured ttl without calling acpx close", async () => {
    const runner = {
      close: vi.fn(async () => undefined),
    };

    await reapIdleThreads({
      store,
      runner,
      now: new Date("2026-03-24T00:00:00.000Z"),
      ttlHours: 24,
    });

    expect(runner.close).not.toHaveBeenCalled();
    expect(store.getCodexThreadBySurface("oc_chat_1", "omt_1")).toMatchObject({
      status: "closed",
    });
  });
});
