import { describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";

describe("desktop completion routing", () => {
  it("routes an exactly bound native thread to its Feishu topic", () => {
    const store = createStoreDouble({
      thread: {
        threadId: "thread-native-1",
        projectId: "proj-a",
        chatId: "oc_group_1",
        feishuThreadId: "omt_topic_1",
      },
      projects: [{
        projectId: "proj-a",
        name: "Repo One",
        chatId: "oc_group_1",
        updatedAt: "2026-04-20T10:00:00.000Z",
      }],
    });
    const bridge = createBridge({ store });

    const target = (bridge as any).resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_owner"],
    });

    expect(target).toEqual({
      mode: "thread",
      chatId: "oc_group_1",
      surfaceRef: "omt_topic_1",
    });
  });

  it("routes to the project group timeline when the native thread has no topic binding", () => {
    const store = createStoreDouble({
      projects: [{
        projectId: "project-key-1",
        name: "Repo One",
        chatId: "oc_group_1",
        updatedAt: "2026-04-20T10:00:00.000Z",
      }],
      projectRecords: {
        "project-key-1": {
          projectId: "project-key-1",
          name: "Repo One",
          cwd: "D:/repo-one",
          repoRoot: "D:/repo-one",
        },
      },
    });
    const codexCatalog = createCatalogDouble({
      thread: {
        threadId: "thread-native-1",
        projectKey: "project-key-1",
        cwd: "D:/repo-one",
      },
    });
    const bridge = createBridge({ store, codexCatalog });

    const target = (bridge as any).resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_owner"],
    });

    expect(target).toEqual({
      mode: "project_group",
      chatId: "oc_group_1",
    });
  });

  it("falls back to a DM target when no topic or project group binding exists", () => {
    const store = createStoreDouble();
    const codexCatalog = createCatalogDouble({
      thread: {
        threadId: "thread-native-1",
        projectKey: "project-key-1",
        cwd: "D:/repo-one",
      },
    });
    const bridge = createBridge({ store, codexCatalog });

    const target = (bridge as any).resolveDesktopCompletionRoute({
      threadId: "thread-native-1",
      allowlist: ["ou_only_owner"],
    });

    expect(target).toEqual({
      mode: "dm",
      peerId: "ou_only_owner",
    });
  });

  it.each([
    {
      name: "an invalid exact topic binding",
      store: createStoreDouble({
        thread: {
          threadId: "thread-native-1",
          projectId: "proj-a",
          chatId: "oc_group_1",
          feishuThreadId: "omt_topic_1",
        },
      }),
      codexCatalog: createCatalogDouble(),
    },
    {
      name: "an invalid project group binding",
      store: createStoreDouble({
        projects: [{
          projectId: "project-key-1",
          name: "Repo One",
          chatId: "oc_group_1",
          updatedAt: "2026-04-20T10:00:00.000Z",
        }],
        projectRecords: {
          "project-key-1": {
            projectId: "project-key-1",
            name: "Repo One",
            cwd: "D:/repo-one",
            repoRoot: "D:/repo-one",
          },
        },
      }),
      codexCatalog: createCatalogDouble({
        thread: {
          threadId: "thread-native-1",
          projectKey: "project-key-1",
          cwd: "D:/repo-one",
        },
      }),
    },
  ])("falls back to DM for $name", ({ store, codexCatalog }) => {
    const bridge = createBridge({ store, codexCatalog });

    const target = (bridge as any).resolveDesktopCompletionRoute({
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

function createBridge(input?: {
  store?: ReturnType<typeof createStoreDouble>;
  codexCatalog?: ReturnType<typeof createCatalogDouble>;
}) {
  return new BridgeService({
    store: input?.store ?? createStoreDouble(),
    runner: {} as any,
    codexCatalog: input?.codexCatalog as any,
  });
}

function createStoreDouble(input?: {
  thread?: {
    threadId: string;
    projectId: string;
    chatId: string;
    feishuThreadId: string;
  };
  projects?: Array<{
    projectId: string;
    name: string;
    chatId: string | null;
    updatedAt: string;
  }>;
  projectRecords?: Record<string, {
    projectId: string;
    name: string;
    cwd: string;
    repoRoot: string;
  }>;
}) {
  const projects = input?.projects ?? [];
  const projectRecords = input?.projectRecords ?? {};
  return {
    getThread: vi.fn().mockReturnValue(
      input?.thread
        ? {
            ...input.thread,
            title: "Thread Title",
            sessionName: input.thread.threadId,
            status: "warm",
            ownerOpenId: "ou_owner",
            anchorMessageId: "om_anchor",
            latestMessageId: "om_latest",
            lastRunId: null,
            lastActivityAt: "2026-04-20T10:00:00.000Z",
            updatedAt: "2026-04-20T10:00:00.000Z",
            archivedAt: null,
          }
        : undefined,
    ),
    listProjects: vi.fn().mockReturnValue(projects),
    getProject: vi.fn((projectId: string) => projectRecords[projectId]),
    getProjectChat: vi.fn((projectId: string) => {
      const project = projects.find(item => item.projectId === projectId && item.chatId);
      if (!project?.chatId) {
        return undefined;
      }

      return {
        projectId,
        chatId: project.chatId,
        groupMessageType: "thread",
        title: project.name,
        isActive: true,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: project.updatedAt,
      };
    }),
  } as any;
}

function createCatalogDouble(input?: {
  thread?: {
    threadId: string;
    projectKey: string;
    cwd: string;
  };
}) {
  return {
    getThread: vi.fn((threadId: string) => {
      if (!input?.thread || input.thread.threadId !== threadId) {
        return undefined;
      }

      return {
        threadId: input.thread.threadId,
        projectKey: input.thread.projectKey,
        cwd: input.thread.cwd,
        displayName: "Repo One",
        title: "Thread Title",
        source: "user",
        archived: false,
        updatedAt: "2026-04-20T10:00:00.000Z",
        createdAt: "2026-04-20T09:00:00.000Z",
        gitBranch: "main",
        cliVersion: "0.0.0",
        rolloutPath: "D:/repo-one/.codex/rollout.jsonl",
      };
    }),
  };
}
