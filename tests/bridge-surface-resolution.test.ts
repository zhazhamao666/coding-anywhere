import { describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/bridge-service.js";

describe("bridge thread surface resolution", () => {
  it("resolves a project thread surface to the stored session", () => {
    const store = {
      getRoot: vi.fn().mockReturnValue({
        id: "root",
        name: "Root",
        cwd: "D:/root",
        repoRoot: "D:/root",
        branchPolicy: "reuse",
        permissionMode: "workspace-write",
        envAllowlist: ["PATH"],
        idleTtlHours: 24,
      }),
      getCodexThreadBySurface: vi.fn().mockReturnValue({
        threadId: "thread-a",
        sessionName: "codex-proj-a-thread-a",
        projectId: "proj-a",
        title: "feishu-nav",
      }),
      getProject: vi.fn().mockReturnValue({
        projectId: "proj-a",
        name: "coding-anywhere",
        cwd: "D:/repo",
        repoRoot: "D:/repo",
      }),
    } as any;

    const bridge = new BridgeService({
      store,
      runner: {} as any,
    });

    const result = (bridge as any).resolveContext({
      channel: "feishu",
      peerId: "ou_demo",
      chatId: "oc_chat_1",
      surfaceType: "thread",
      surfaceRef: "omt_1",
    });

    expect(store.getCodexThreadBySurface).toHaveBeenCalledWith("oc_chat_1", "omt_1");
    expect(result.context).toEqual({
      sessionName: "codex-proj-a-thread-a",
      cwd: "D:/repo",
    });
  });
});
