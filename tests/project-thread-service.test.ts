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
    const store = {
      createCodexThread: vi.fn(),
    } as any;

    const service = new ProjectThreadService({ apiClient, store });

    const thread = await service.createThread({
      projectId: "proj-a",
      chatId: "oc_chat_1",
      ownerOpenId: "ou_user",
      title: "feishu-nav",
    });

    expect(apiClient.sendTextMessageToChat).toHaveBeenCalledWith(
      "oc_chat_1",
      expect.stringContaining("feishu-nav"),
    );
    expect(store.createCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
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
