import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/workspace/session-store.js";

describe("SessionStore desktop notification-state persistence", () => {
  let rootDir: string;
  let dbPath: string;
  let store: SessionStore | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-desktop-notification-state-"));
    dbPath = path.join(rootDir, "bridge.db");
  });

  afterEach(() => {
    store?.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  function createSessionStore(): SessionStore {
    store = new SessionStore(dbPath);
    return store;
  }

  function reloadSessionStore(): SessionStore {
    store?.close();
    store = new SessionStore(dbPath);
    return store;
  }

  it("creates, reloads, and updates desktop notification state for an in-flight run", () => {
    const initialStore = createSessionStore();

    initialStore.upsertCodexThreadDesktopNotificationState({
      threadId: "thread-1",
      activeRunKey: "thread-1:run-1",
      status: "running_notified",
      startedAt: "2026-04-22T10:00:00.000Z",
      lastEventAt: "2026-04-22T10:00:05.000Z",
      messageId: "om_running_1",
      deliveryMode: "dm",
      peerId: "ou_demo",
      latestPublicMessage: "我先补测试和文档。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 2,
      lastRenderHash: "render-hash-1",
    });

    let reloadedStore = reloadSessionStore();
    expect(reloadedStore.getCodexThreadDesktopNotificationState("thread-1")).toMatchObject({
      threadId: "thread-1",
      activeRunKey: "thread-1:run-1",
      status: "running_notified",
      startedAt: "2026-04-22T10:00:00.000Z",
      lastEventAt: "2026-04-22T10:00:05.000Z",
      messageId: "om_running_1",
      deliveryMode: "dm",
      peerId: "ou_demo",
      latestPublicMessage: "我先补测试和文档。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 2,
      lastRenderHash: "render-hash-1",
    });

    reloadedStore.upsertCodexThreadDesktopNotificationState({
      threadId: "thread-1",
      activeRunKey: "thread-1:run-1",
      status: "running_notified",
      lastEventAt: "2026-04-22T10:00:10.000Z",
      messageId: "om_running_1",
      deliveryMode: "dm",
      peerId: "ou_demo",
      latestPublicMessage: "测试已经补完，我现在同步文档。",
      commandCount: 3,
      lastRenderHash: "render-hash-2",
    });

    reloadedStore = reloadSessionStore();
    expect(reloadedStore.getCodexThreadDesktopNotificationState("thread-1")).toMatchObject({
      threadId: "thread-1",
      activeRunKey: "thread-1:run-1",
      messageId: "om_running_1",
      deliveryMode: "dm",
      peerId: "ou_demo",
      latestPublicMessage: "测试已经补完，我现在同步文档。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 3,
      lastEventAt: "2026-04-22T10:00:10.000Z",
      lastRenderHash: "render-hash-2",
    });
  });

  it("stores and clears frozen route context for a running desktop notification", () => {
    const sessionStore = createSessionStore();

    sessionStore.upsertCodexThreadDesktopNotificationState({
      threadId: "thread-1",
      activeRunKey: "thread-1:run-1",
      status: "running_notified",
      messageId: "om_running_1",
      deliveryMode: "thread",
      chatId: "oc_group_1",
      surfaceType: "thread",
      surfaceRef: "omt_topic_1",
      anchorMessageId: "om_anchor_1",
      lastRenderHash: "render-hash-1",
    });

    expect(sessionStore.getCodexThreadDesktopNotificationState("thread-1")).toMatchObject({
      threadId: "thread-1",
      deliveryMode: "thread",
      chatId: "oc_group_1",
      surfaceType: "thread",
      surfaceRef: "omt_topic_1",
      anchorMessageId: "om_anchor_1",
    });

    sessionStore.clearCodexThreadDesktopNotificationState("thread-1");

    expect(sessionStore.getCodexThreadDesktopNotificationState("thread-1")).toBeUndefined();
  });
});
