import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

import { AcpxRunner } from "../src/acpx-runner.js";
import { BridgeService } from "../src/bridge-service.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("BridgeService real runner bridge coverage", () => {
  let rootDir: string;
  let store: SessionStore;
  let bridgeRootCwd: string;

  beforeEach(() => {
    execaMock.mockReset();
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-real-codex-"));
    bridgeRootCwd = path.join(rootDir, "repos");
    store = new SessionStore(path.join(rootDir, "bridge.db"));
    store.upsertRoot({
      id: "main",
      name: "Main Root",
      cwd: bridgeRootCwd,
      repoRoot: bridgeRootCwd,
      branchPolicy: "reuse",
      permissionMode: "workspace-write",
      envAllowlist: ["PATH"],
      idleTtlHours: 24,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("boots a new DM thread through the real AcpxRunner and records the bridge run", async () => {
    execaMock
      .mockImplementationOnce(() =>
        createChildFromFixture("create-thread.jsonl", 0),
      )
      .mockImplementationOnce(() =>
        createChildFromFixture("resume-thread.jsonl", 0),
      );

    const runner = new AcpxRunner("acpx", "codex");
    const service = new BridgeService({
      store,
      runner,
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "请先查看当前目录，然后运行测试",
    });

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "codex",
      ["exec", "--json", "-"],
      expect.objectContaining({
        cwd: bridgeRootCwd,
        input: expect.stringContaining("Topic: 请先查看当前目录，然后运行测试"),
        reject: false,
      }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "codex",
      [
        "exec",
        "resume",
        "--json",
        "019d34e0-254e-70f1-9dd5-097fb862d391",
        "-",
      ],
      expect.objectContaining({
        cwd: bridgeRootCwd,
        input: expect.stringContaining("[bridge-context]"),
        reject: false,
      }),
    );

    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "RESUMED",
      },
    ]);
    expect(store.getCodexWindowBinding("feishu", "ou_demo")).toMatchObject({
      codexThreadId: "019d34e0-254e-70f1-9dd5-097fb862d391",
    });

    const observabilityStore = store as any;
    const runs = observabilityStore.listRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      channel: "feishu",
      peerId: "ou_demo",
      projectId: null,
      threadId: "019d34e0-254e-70f1-9dd5-097fb862d391",
      sessionName: "019d34e0-254e-70f1-9dd5-097fb862d391",
      status: "done",
      stage: "done",
    });
    expect(observabilityStore.listRunEvents(runs[0].runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "received" }),
        expect.objectContaining({ stage: "tool_call" }),
        expect.objectContaining({ stage: "done" }),
      ]),
    );
  });

  it("resumes a bound DM thread through the real AcpxRunner and keeps observability aligned", async () => {
    store.createProject({
      projectId: "proj-native",
      name: "coding-anywhere",
      cwd: path.join(bridgeRootCwd, "coding-anywhere"),
      repoRoot: path.join(bridgeRootCwd, "coding-anywhere"),
    });
    store.bindCodexWindow({
      channel: "feishu",
      peerId: "ou_demo",
      codexThreadId: "thread-native-current",
    });

    execaMock.mockReturnValue(
      createChildFromFixture("resume-thread.jsonl", 0),
    );

    const runner = new AcpxRunner("acpx", "codex");
    const service = new BridgeService({
      store,
      runner,
      codexCatalog: {
        listProjects: vi.fn(() => [
          {
            projectKey: "proj-native",
            cwd: path.join(bridgeRootCwd, "coding-anywhere"),
            displayName: "coding-anywhere",
            threadCount: 1,
            activeThreadCount: 1,
            lastUpdatedAt: "2026-03-29T00:00:00.000Z",
            gitBranch: "main",
          },
        ]),
        getProject: vi.fn(() => ({
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          threadCount: 1,
          activeThreadCount: 1,
          lastUpdatedAt: "2026-03-29T00:00:00.000Z",
          gitBranch: "main",
        })),
        listThreads: vi.fn(() => [
          {
            threadId: "thread-native-current",
            projectKey: "proj-native",
            cwd: path.join(bridgeRootCwd, "coding-anywhere"),
            displayName: "coding-anywhere",
            title: "follow-up",
            source: "vscode",
            archived: false,
            updatedAt: "2026-03-29T00:00:00.000Z",
            createdAt: "2026-03-28T00:00:00.000Z",
            gitBranch: "main",
            cliVersion: "0.116.0",
            rolloutPath: "D:/rollout",
          },
        ]),
        getThread: vi.fn(() => ({
          threadId: "thread-native-current",
          projectKey: "proj-native",
          cwd: path.join(bridgeRootCwd, "coding-anywhere"),
          displayName: "coding-anywhere",
          title: "follow-up",
          source: "vscode",
          archived: false,
          updatedAt: "2026-03-29T00:00:00.000Z",
          createdAt: "2026-03-28T00:00:00.000Z",
          gitBranch: "main",
          cliVersion: "0.116.0",
          rolloutPath: "D:/rollout",
        })),
      },
    });

    const replies = await service.handleMessage({
      channel: "feishu",
      peerId: "ou_demo",
      text: "继续对话",
    });

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      "codex",
      ["exec", "resume", "--json", "thread-native-current", "-"],
      expect.objectContaining({
        cwd: path.join(bridgeRootCwd, "coding-anywhere"),
        input: "继续对话",
        reject: false,
      }),
    );
    expect(replies).toEqual([
      {
        kind: "assistant",
        text: "RESUMED",
      },
    ]);

    const observabilityStore = store as any;
    const runs = observabilityStore.listRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      channel: "feishu",
      peerId: "ou_demo",
      projectId: "proj-native",
      threadId: "thread-native-current",
      sessionName: "thread-native-current",
      status: "done",
      stage: "done",
    });
    expect(observabilityStore.listRunEvents(runs[0].runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "received" }),
        expect.objectContaining({ stage: "tool_call" }),
        expect.objectContaining({ stage: "done" }),
      ]),
    );
  });
});

function createChildFromFixture(fileName: string, exitCode: number) {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "codex",
    fileName,
  );
  const lines = readFileSync(fixturePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map(line => `${line}\n`);

  return Object.assign(
    Promise.resolve({
      exitCode,
    }),
    {
      stdout: Readable.from(lines),
    },
  );
}
