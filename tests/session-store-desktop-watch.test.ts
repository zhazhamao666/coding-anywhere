import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/workspace/session-store.js";

describe("SessionStore desktop watch persistence", () => {
  let rootDir: string;
  let dbPath: string;
  let store: SessionStore | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-desktop-watch-"));
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

  it("creates, reloads, and lists desktop watch state for a native thread", () => {
    const initialStore = createSessionStore();

    initialStore.upsertCodexThreadWatchState({
      threadId: "thread-1",
      rolloutPath: "C:/Users/demo/.codex/sessions/rollout-1.jsonl",
      rolloutMtime: "2026-04-20T10:00:00.000Z",
      lastReadOffset: 123,
      lastCompletionKey: "thread-1:completion-1",
      lastNotifiedCompletionKey: "thread-1:notified-1",
    });

    const reloadedStore = reloadSessionStore();

    expect(reloadedStore.getCodexThreadWatchState("thread-1")).toMatchObject({
      threadId: "thread-1",
      rolloutPath: "C:/Users/demo/.codex/sessions/rollout-1.jsonl",
      rolloutMtime: "2026-04-20T10:00:00.000Z",
      lastReadOffset: 123,
      lastCompletionKey: "thread-1:completion-1",
      lastNotifiedCompletionKey: "thread-1:notified-1",
    });
    expect(reloadedStore.listCodexThreadWatchStates()).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        lastReadOffset: 123,
        lastCompletionKey: "thread-1:completion-1",
        lastNotifiedCompletionKey: "thread-1:notified-1",
      }),
    ]);
  });

  it("updates read offsets without clearing persisted completion notification keys", () => {
    const sessionStore = createSessionStore();

    sessionStore.upsertCodexThreadWatchState({
      threadId: "thread-1",
      rolloutPath: "C:/Users/demo/.codex/sessions/rollout-1.jsonl",
      rolloutMtime: "2026-04-20T10:00:00.000Z",
      lastReadOffset: 123,
      lastCompletionKey: "thread-1:completion-1",
      lastNotifiedCompletionKey: "thread-1:notified-1",
    });

    sessionStore.upsertCodexThreadWatchState({
      threadId: "thread-1",
      rolloutPath: "C:/Users/demo/.codex/sessions/rollout-1.jsonl",
      rolloutMtime: "2026-04-20T10:05:00.000Z",
      lastReadOffset: 456,
      lastCompletionKey: "thread-1:completion-2",
      lastNotifiedCompletionKey: "thread-1:notified-2",
    });

    sessionStore.upsertCodexThreadWatchState({
      threadId: "thread-1",
      rolloutPath: "C:/Users/demo/.codex/sessions/rollout-1.jsonl",
      rolloutMtime: "2026-04-20T10:06:00.000Z",
      lastReadOffset: 789,
    });

    expect(sessionStore.getCodexThreadWatchState("thread-1")).toMatchObject({
      threadId: "thread-1",
      rolloutMtime: "2026-04-20T10:06:00.000Z",
      lastReadOffset: 789,
      lastCompletionKey: "thread-1:completion-2",
      lastNotifiedCompletionKey: "thread-1:notified-2",
    });
  });
});
