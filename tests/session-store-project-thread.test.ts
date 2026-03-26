import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/workspace/session-store.js";

describe("SessionStore project thread persistence", () => {
  let rootDir: string;
  let store: SessionStore | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-project-thread-"));
  });

  afterEach(() => {
    store?.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("creates and reloads a codex thread binding", () => {
    store = new SessionStore(path.join(rootDir, "bridge.db"));

    const projectStore = store as any;
    projectStore.createProject({
      projectId: "proj-a",
      name: "coding-anywhere",
      cwd: "D:/repo",
      repoRoot: "D:/repo",
    });
    projectStore.upsertProjectChat({
      projectId: "proj-a",
      chatId: "oc_chat_1",
      groupMessageType: "thread",
      title: "Codex | coding-anywhere",
    });
    projectStore.createCodexThread({
      threadId: "thread-a",
      projectId: "proj-a",
      feishuThreadId: "omt_1",
      chatId: "oc_chat_1",
      anchorMessageId: "om_anchor",
      latestMessageId: "om_anchor",
      sessionName: "codex-proj-a-thread-a",
      title: "feishu-nav",
      ownerOpenId: "ou_user",
    });

    expect(projectStore.getCodexThreadBySurface("oc_chat_1", "omt_1")).toMatchObject({
      threadId: "thread-a",
      projectId: "proj-a",
      sessionName: "codex-proj-a-thread-a",
      anchorMessageId: "om_anchor",
    });
  });
});
