import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/workspace/session-store.js";

describe("SessionStore group chat Codex bindings", () => {
  let rootDir: string;
  let dbPath: string;
  let store: SessionStore | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-chat-binding-"));
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

  it("creates, reloads, and updates a direct group chat binding to a Codex thread", () => {
    const initialStore = createSessionStore();

    initialStore.bindCodexChat({
      channel: "feishu",
      chatId: "oc_chat_alpha",
      codexThreadId: "thread-alpha-1",
    });

    let reloadedStore = reloadSessionStore();
    expect(reloadedStore.getCodexChatBinding("feishu", "oc_chat_alpha")).toMatchObject({
      channel: "feishu",
      chatId: "oc_chat_alpha",
      codexThreadId: "thread-alpha-1",
    });

    reloadedStore.bindCodexChat({
      channel: "feishu",
      chatId: "oc_chat_alpha",
      codexThreadId: "thread-alpha-2",
    });

    reloadedStore = reloadSessionStore();
    expect(reloadedStore.getCodexChatBinding("feishu", "oc_chat_alpha")).toMatchObject({
      codexThreadId: "thread-alpha-2",
    });
  });

  it("clears a direct group chat binding without affecting missing rows", () => {
    const sessionStore = createSessionStore();

    sessionStore.bindCodexChat({
      channel: "feishu",
      chatId: "oc_chat_alpha",
      codexThreadId: "thread-alpha-1",
    });

    sessionStore.clearCodexChatBinding("feishu", "oc_chat_alpha");
    sessionStore.clearCodexChatBinding("feishu", "oc_chat_missing");

    expect(sessionStore.getCodexChatBinding("feishu", "oc_chat_alpha")).toBeUndefined();
  });
});
