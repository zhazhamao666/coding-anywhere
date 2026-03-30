import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import type { RunOutcome } from "../src/types.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("run delivery target persistence", () => {
  let rootDir: string;
  let store: SessionStore;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "run-targets-"));
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
    });
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("stores the thread delivery target for each run", async () => {
    const service = new BridgeService({
      store,
      runner: {
        createThread: vi.fn(),
        ensureSession: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        submitVerbatim: vi.fn(async (): Promise<RunOutcome> => ({
          exitCode: 0,
          events: [{ type: "done", content: "ok" }],
        })),
      },
    });

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_user",
      chatId: "oc_chat_1",
      surfaceType: "thread",
      surfaceRef: "omt_1",
      text: "继续处理",
    });

    const [run] = store.listRuns({ limit: 1 });
    expect(run).toMatchObject({
      projectId: "proj-a",
      threadId: "thread-a",
      deliveryChatId: "oc_chat_1",
      deliverySurfaceType: "thread",
      deliverySurfaceRef: "omt_1",
      sessionName: "thread-a",
    });
  });
});
