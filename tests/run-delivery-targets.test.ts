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
    store.upsertProjectChat({
      projectId: "proj-a",
      chatId: "oc_chat_1",
      groupMessageType: "thread",
      title: "coding-anywhere",
    });
    store.bindCodexChat({
      channel: "feishu",
      chatId: "oc_chat_1",
      codexThreadId: "thread-a",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("stores the group mainline delivery target for each run", async () => {
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
      text: "继续处理",
    });

    const [run] = store.listRuns({ limit: 1 });
    expect(run).toMatchObject({
      projectId: "proj-a",
      threadId: "thread-a",
      deliveryChatId: "oc_chat_1",
      deliverySurfaceType: null,
      deliverySurfaceRef: null,
      sessionName: "thread-a",
    });
  });

  it("keeps the same delivery target when a staged image is consumed for the run", async () => {
    store.savePendingBridgeAsset({
      channel: "feishu",
      peerId: "ou_user",
      chatId: "oc_chat_1",
      messageId: "om_image_1",
      resourceKey: "img_thread_1",
      localPath: "D:/assets/thread.png",
      fileName: "thread.png",
      mimeType: "image/png",
      fileSize: 2048,
    });

    const runner = {
      createThread: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      submitVerbatim: vi.fn(async (): Promise<RunOutcome> => ({
        exitCode: 0,
        events: [{ type: "done", content: "ok" }],
      })),
    };
    const service = new BridgeService({
      store,
      runner,
    });

    await service.handleMessage({
      channel: "feishu",
      peerId: "ou_user",
      chatId: "oc_chat_1",
      text: "继续处理图片",
    });

    expect(runner.submitVerbatim).toHaveBeenCalledWith(
      {
        targetKind: "codex_thread",
        threadId: "thread-a",
        sessionName: "thread-a",
        cwd: "D:/repo",
      },
      expect.stringContaining("[bridge-attachments]"),
      {
        images: ["D:/assets/thread.png"],
      },
      expect.any(Function),
    );

    const [run] = store.listRuns({ limit: 1 });
    expect(run).toMatchObject({
      projectId: "proj-a",
      threadId: "thread-a",
      deliveryChatId: "oc_chat_1",
      deliverySurfaceType: null,
      deliverySurfaceRef: null,
      sessionName: "thread-a",
    });
    expect(store.listPendingBridgeAssetsForSurface({
      channel: "feishu",
      peerId: "ou_user",
      chatId: "oc_chat_1",
    })).toEqual([]);
  });
});
