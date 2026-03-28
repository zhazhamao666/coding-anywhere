import { describe, expect, it, vi } from "vitest";

import { ProjectThreadService } from "../src/project-thread-service.js";

describe("ProjectThreadService", () => {
  it("creates a thread root message and persists thread metadata", async () => {
    const apiClient = {
      sendTextMessageToChat: vi.fn().mockResolvedValue({
        messageId: "om_anchor",
        threadId: "omt_thread_1",
      }),
    } as any;
    const runner = {
      createThread: vi.fn().mockResolvedValue({
        threadId: "thread-native-1",
        exitCode: 0,
        events: [],
      }),
    } as any;
    const store = {
      createCodexThread: vi.fn(),
    } as any;

    const service = new ProjectThreadService({ apiClient, runner, store });

    const thread = await service.createThread({
      projectId: "proj-a",
      cwd: "D:/repo",
      chatId: "oc_chat_1",
      ownerOpenId: "ou_user",
      title: "feishu-nav",
    });

    expect(apiClient.sendTextMessageToChat).toHaveBeenCalledWith(
      "oc_chat_1",
      expect.stringContaining("feishu-nav"),
    );
    expect(runner.createThread).toHaveBeenCalledWith({
      cwd: "D:/repo",
      prompt: expect.stringContaining("Topic: feishu-nav"),
    });
    expect(store.createCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-native-1",
        sessionName: "thread-native-1",
        feishuThreadId: "omt_thread_1",
        anchorMessageId: "om_anchor",
        latestMessageId: "om_anchor",
        ownerOpenId: "ou_user",
      }),
    );
    expect(thread).toEqual(
      expect.objectContaining({
        feishuThreadId: "omt_thread_1",
        anchorMessageId: "om_anchor",
      }),
    );
  });
});
