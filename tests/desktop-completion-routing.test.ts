import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("desktop completion routing", () => {
  const harnesses: RoutingHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      harness?.store.close();
      if (harness) {
        rmSync(harness.rootDir, { recursive: true, force: true });
      }
    }
  });

  it("routes an exactly bound native thread to the preferred Feishu topic even when a project group binding also exists", () => {
    const harness = createRoutingHarness(harnesses);
    seedProjectBinding(harness.store, {
      projectId: "proj-a",
      name: "Repo One",
      cwd: "D:/repo-one",
      chatId: "oc_group_1",
      updatedAt: "2026-04-20T12:00:00.000Z",
    });
    seedThreadBinding(harness.store, {
      threadId: "thread-native-1",
      projectId: "proj-a",
      chatId: "oc_group_1",
      feishuThreadId: "omt_topic_001",
      createdAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-20T12:00:00.000Z",
    });
    seedThreadBinding(harness.store, {
      threadId: "thread-native-1",
      projectId: "proj-a",
      chatId: "oc_group_1",
      feishuThreadId: "omt_topic_999",
      createdAt: "2026-04-20T11:00:00.000Z",
      updatedAt: "2026-04-20T12:00:00.000Z",
    });

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_owner"],
    });

    expect(target).toEqual({
      mode: "thread",
      chatId: "oc_group_1",
      surfaceRef: "omt_topic_999",
      anchorMessageId: "om_anchor_omt_topic_999",
    });
  });

  it("routes to the project group timeline when the native thread has no topic binding", () => {
    const harness = createRoutingHarness(harnesses, {
      catalogThread: {
        threadId: "thread-native-1",
        projectKey: "project-key-1",
        cwd: "D:/repo-one",
      },
    });
    seedProjectBinding(harness.store, {
      projectId: "project-key-1",
      name: "Repo One",
      cwd: "D:/repo-one",
      chatId: "oc_group_1",
    });

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_owner"],
    });

    expect(target).toEqual({
      mode: "project_group",
      chatId: "oc_group_1",
    });
  });

  it("routes to the project group timeline via a unique cwd match when projectId differs from projectKey", () => {
    const harness = createRoutingHarness(harnesses, {
      catalogThread: {
        threadId: "thread-native-1",
        projectKey: "catalog-project-key",
        cwd: "D:/repo-one",
      },
    });
    seedProjectBinding(harness.store, {
      projectId: "local-project-id",
      name: "Repo One",
      cwd: "D:/repo-one",
      chatId: "oc_group_1",
    });

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_owner"],
    });

    expect(target).toEqual({
      mode: "project_group",
      chatId: "oc_group_1",
    });
  });

  it("falls back to DM when multiple bound projects match the same cwd", () => {
    const harness = createRoutingHarness(harnesses, {
      catalogThread: {
        threadId: "thread-native-1",
        projectKey: "catalog-project-key",
        cwd: "D:/repo-one",
      },
    });
    seedProjectBinding(harness.store, {
      projectId: "local-project-a",
      name: "Repo A",
      cwd: "D:/repo-one",
      chatId: "oc_group_1",
    });
    seedProjectBinding(harness.store, {
      projectId: "local-project-b",
      name: "Repo B",
      cwd: "D:/repo-one",
      chatId: "oc_group_2",
    });

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_only_owner"],
    });

    expect(target).toEqual({
      mode: "dm",
      peerId: "ou_only_owner",
    });
  });

  it("falls back to a DM target when no topic or project group binding exists", () => {
    const harness = createRoutingHarness(harnesses, {
      catalogThread: {
        threadId: "thread-native-1",
        projectKey: "project-key-1",
        cwd: "D:/repo-one",
      },
    });

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_only_owner"],
    });

    expect(target).toEqual({
      mode: "dm",
      peerId: "ou_only_owner",
    });
  });

  it("falls back to the only known DM peer when owner config and allowlist are empty", () => {
    const harness = createRoutingHarness(harnesses, {
      catalogThread: {
        threadId: "thread-native-1",
        projectKey: "project-key-1",
        cwd: "D:/repo-one",
      },
    });
    harness.store.recordDmPeer({
      channel: "feishu",
      peerId: "ou_seen_dm_user",
      updatedAt: "2026-04-20T12:00:00.000Z",
    });

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: [],
    });

    expect(target).toEqual({
      mode: "dm",
      peerId: "ou_seen_dm_user",
    });
  });

  it("uses the DM binding for the native thread when multiple DM peers are known", () => {
    const harness = createRoutingHarness(harnesses, {
      catalogThread: {
        threadId: "thread-native-1",
        projectKey: "project-key-1",
        cwd: "D:/repo-one",
      },
    });
    harness.store.recordDmPeer({
      channel: "feishu",
      peerId: "ou_first",
      updatedAt: "2026-04-20T11:00:00.000Z",
    });
    harness.store.recordDmPeer({
      channel: "feishu",
      peerId: "ou_second",
      updatedAt: "2026-04-20T12:00:00.000Z",
    });
    harness.store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_first",
      codexThreadId: "thread-native-1",
    });

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: [],
    });

    expect(target).toEqual({
      mode: "dm",
      peerId: "ou_first",
    });
  });

  it("throws an explicit error when DM fallback is ambiguous", () => {
    const harness = createRoutingHarness(harnesses);

    expect(() => harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_first", "ou_second"],
    })).toThrowError("FEISHU_DESKTOP_OWNER_OPEN_ID_REQUIRED_FOR_DM_FALLBACK");
  });

  it("throws when multiple DM peers are known and no owner can be inferred", () => {
    const harness = createRoutingHarness(harnesses);
    harness.store.recordDmPeer({
      channel: "feishu",
      peerId: "ou_first",
    });
    harness.store.recordDmPeer({
      channel: "feishu",
      peerId: "ou_second",
    });

    expect(() => harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: [],
    })).toThrowError("FEISHU_DESKTOP_OWNER_OPEN_ID_REQUIRED_FOR_DM_FALLBACK");
  });

  it.each([
    {
      name: "an invalid exact topic binding",
      setup: (harness: RoutingHarness) => {
        seedProjectBinding(harness.store, {
          projectId: "proj-a",
          name: "Repo One",
          cwd: "D:/repo-one",
          chatId: "oc_group_1",
        });
        seedThreadBinding(harness.store, {
          threadId: "thread-native-1",
          projectId: "proj-a",
          chatId: "oc_group_1",
          feishuThreadId: "omt_topic_1",
        });
      },
    },
    {
      name: "an invalid project group binding",
      setup: (harness: RoutingHarness) => {
        seedProjectBinding(harness.store, {
          projectId: "project-key-1",
          name: "Repo One",
          cwd: "D:/repo-one",
          chatId: "oc_group_1",
        });
        harness.codexCatalog.getThread.mockReturnValue({
          threadId: "thread-native-1",
          projectKey: "project-key-1",
          cwd: "D:/repo-one",
          displayName: "Repo One",
          title: "Thread Title",
          source: "user",
          archived: false,
          updatedAt: "2026-04-20T10:00:00.000Z",
          createdAt: "2026-04-20T09:00:00.000Z",
          gitBranch: "main",
          cliVersion: "0.0.0",
          rolloutPath: "D:/repo-one/.codex/rollout.jsonl",
        });
      },
    },
  ])("falls back to DM for $name", ({ setup }) => {
    const harness = createRoutingHarness(harnesses);
    setup(harness);

    const target = harness.bridge.resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_first", "ou_second"],
      desktopOwnerOpenId: "ou_desktop_owner",
      routeValidator: (candidate: { mode: string }) => candidate.mode === "dm",
    });

    expect(target).toEqual({
      mode: "dm",
      peerId: "ou_desktop_owner",
    });
  });
});

interface RoutingHarness {
  rootDir: string;
  store: SessionStore;
  bridge: BridgeService;
  codexCatalog: {
    getThread: ReturnType<typeof vi.fn>;
  };
}

function createRoutingHarness(
  harnesses: RoutingHarness[],
  input?: {
    catalogThread?: {
      threadId: string;
      projectKey: string;
      cwd: string;
    };
  },
): RoutingHarness {
  const rootDir = mkdtempSync(path.join(tmpdir(), "desktop-routing-"));
  const store = new SessionStore(path.join(rootDir, "bridge.db"));
  const codexCatalog = createCatalogDouble(input?.catalogThread);
  const bridge = new BridgeService({
    store,
    runner: {} as any,
    codexCatalog: codexCatalog as any,
  });
  const harness = {
    rootDir,
    store,
    bridge,
    codexCatalog,
  };
  harnesses.push(harness);
  return harness;
}

function seedProjectBinding(
  store: SessionStore,
  input: {
    projectId: string;
    name: string;
    cwd: string;
    chatId: string;
    updatedAt?: string;
  },
): void {
  const createdAt = input.updatedAt ?? "2026-04-20T10:00:00.000Z";
  const updatedAt = input.updatedAt ?? createdAt;
  store.createProject({
    projectId: input.projectId,
    name: input.name,
    cwd: input.cwd,
    repoRoot: input.cwd,
    createdAt,
    updatedAt,
  });
  store.upsertProjectChat({
    projectId: input.projectId,
    chatId: input.chatId,
    groupMessageType: "thread",
    title: `Codex | ${input.name}`,
    createdAt,
    updatedAt,
  });
}

function seedThreadBinding(
  store: SessionStore,
  input: {
    threadId: string;
    projectId: string;
    chatId: string;
    feishuThreadId: string;
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const createdAt = input.createdAt ?? "2026-04-20T10:00:00.000Z";
  const updatedAt = input.updatedAt ?? createdAt;
  store.createCodexThread({
    threadId: input.threadId,
    projectId: input.projectId,
    feishuThreadId: input.feishuThreadId,
    chatId: input.chatId,
    anchorMessageId: `om_anchor_${input.feishuThreadId}`,
    latestMessageId: `om_latest_${input.feishuThreadId}`,
    sessionName: input.threadId,
    title: input.feishuThreadId,
    ownerOpenId: "ou_owner",
    status: "warm",
    lastRunId: null,
    lastActivityAt: updatedAt,
    createdAt,
    updatedAt,
    archivedAt: null,
  });
}

function createCatalogDouble(
  thread?: {
    threadId: string;
    projectKey: string;
    cwd: string;
  },
) {
  return {
    getThread: vi.fn((threadId: string) => {
      if (!thread || thread.threadId !== threadId) {
        return undefined;
      }

      return {
        threadId: thread.threadId,
        projectKey: thread.projectKey,
        cwd: thread.cwd,
        displayName: "Repo One",
        title: "Thread Title",
        source: "user",
        archived: false,
        updatedAt: "2026-04-20T10:00:00.000Z",
        createdAt: "2026-04-20T09:00:00.000Z",
        gitBranch: "main",
        cliVersion: "0.0.0",
        rolloutPath: `${thread.cwd}/.codex/rollout.jsonl`,
      };
    }),
  };
}
