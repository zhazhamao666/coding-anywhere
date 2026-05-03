import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexDesktopCompletionEvent,
  CodexDesktopProgressSnapshot,
} from "../src/codex-desktop-completion-observer.js";
import { DesktopCompletionNotifier } from "../src/desktop-completion-notifier.js";
import { SessionStore } from "../src/workspace/session-store.js";

describe("DesktopCompletionNotifier", () => {
  const harnesses: NotifierHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      harness?.store.close();
      if (harness) {
        rmSync(harness.rootDir, { recursive: true, force: true });
      }
    }
    rmSync(desktopCompletionOutputRoot(), { recursive: true, force: true });
  });

  it("sends a DM completion card without a second full-result message and advances the notified key", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "任务已经处理完成。",
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledWith(
      "ou_demo",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务已完成",
          }),
        }),
      }),
    );
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.apiClient.replyTextMessage).not.toHaveBeenCalled();
    expect(harness.apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
  });

  it("delivers completion bridge assets to a DM after sending the cleaned completion card", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "desktop-completion-assets-"));
    const outputRoot = desktopCompletionOutputRoot();
    const imagePath = path.join(outputRoot, "chart.png");
    const filePath = path.join(outputRoot, "report.md");
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(imagePath, "png");
    writeFileSync(filePath, "# report\n");

    try {
      const harness = createHarness(harnesses, {
        threadCwd: cwd,
      });
      seedWatchState(harness.store, {
        threadId: "thread-native-1",
      });

      await harness.notifier.publish({
        completion: createCompletion({
          finalAssistantText: [
            "任务已经处理完成。",
            "[bridge-assets]",
            JSON.stringify({
                assets: [
                  { kind: "image", path: imagePath, caption: "结果图" },
                  { kind: "file", path: filePath, file_name: "report.md", caption: "结果报告" },
                ],
              }),
            "[/bridge-assets]",
          ].join("\n"),
        }),
        target: {
          mode: "dm",
          peerId: "ou_demo",
        },
      });

      const card = harness.apiClient.sendInteractiveCard.mock.calls[0]?.[1] as Record<string, unknown>;
      const visibleText = collectVisibleText(card).join("\n");
      expect(visibleText).toContain("任务已经处理完成。");
      expect(visibleText).not.toContain("[bridge-assets]");
      expect(harness.apiClient.uploadImage).toHaveBeenCalledWith({
        imagePath,
      });
      expect(harness.apiClient.sendImageMessage).toHaveBeenCalledWith("ou_demo", "img_desktop_1");
      expect(harness.apiClient.uploadFile).toHaveBeenCalledWith({
        filePath,
        fileName: "report.md",
        fileType: undefined,
        duration: undefined,
      });
      expect(harness.apiClient.sendFileMessage).toHaveBeenCalledWith("ou_demo", "file_desktop_1");
      expect(harness.apiClient.sendInteractiveCard.mock.invocationCallOrder[0]).toBeLessThan(
        harness.apiClient.uploadImage.mock.invocationCallOrder[0] ?? 0,
      );
      expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not deliver desktop completion bridge assets directly from the thread cwd", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "desktop-completion-cwd-assets-"));
    const filePath = path.join(cwd, "secret.md");
    writeFileSync(filePath, "# secret\n");

    try {
      const harness = createHarness(harnesses, {
        threadCwd: cwd,
      });
      seedWatchState(harness.store, {
        threadId: "thread-native-1",
      });

      await harness.notifier.publish({
        completion: createCompletion({
          finalAssistantText: [
            "任务已经处理完成。",
            "[bridge-assets]",
            JSON.stringify({
              assets: [
                { kind: "file", path: "secret.md", file_name: "secret.md" },
              ],
            }),
            "[/bridge-assets]",
          ].join("\n"),
        }),
        target: {
          mode: "dm",
          peerId: "ou_demo",
        },
      });

      expect(harness.apiClient.uploadFile).not.toHaveBeenCalled();
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledWith(
        "ou_demo",
        expect.stringContaining("[ca] asset unavailable: disallowed path secret.md"),
      );
      expect(JSON.stringify(harness.apiClient.sendTextMessage.mock.calls)).not.toContain(filePath);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates a running DM card, stores the frozen route, and does not advance the completion key yet", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });

    await harness.notifier.publishRunning({
      threadId: "thread-native-1",
      progress: createProgressSnapshot(),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledWith(
      "ou_demo",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务进行中",
          }),
        }),
      }),
    );
    const runningCard = harness.apiClient.sendInteractiveCard.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(collectButtons(runningCard)).toEqual([]);
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });
    expect(harness.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
      threadId: "thread-native-1",
      activeRunKey: "thread-native-1:turn-1",
      status: "running_notified",
      messageId: "om_dm_card_1",
      deliveryMode: "dm",
      peerId: "ou_demo",
      latestPublicMessage: "Task 1 已 review 完，我现在补测试和文档。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 3,
    });
  });

  it("patches an existing running card into a completed card without sending an extra final result message", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });
    harness.store.upsertCodexThreadDesktopNotificationState({
      threadId: "thread-native-1",
      activeRunKey: "thread-native-1:turn-1",
      status: "running_notified",
      startedAt: "2026-04-22T10:00:00.000Z",
      lastEventAt: "2026-04-22T10:00:06.000Z",
      messageId: "om_running_1",
      deliveryMode: "dm",
      peerId: "ou_demo",
      latestPublicMessage: "Task 1 已 review 完，我现在补测试和文档。",
      planTodos: [
        { text: "Task 1: Review implementation", completed: true },
        { text: "Task 2: Add tests", completed: false },
      ],
      commandCount: 3,
      lastRenderHash: "render-1",
    });

    await harness.notifier.publishCompletion({
      completion: createCompletion({
        finalAssistantText: "Task 1 已完成，测试和文档也已同步。",
      }),
      progress: createProgressSnapshot({
        commandCount: 4,
        latestPublicMessage: "Task 1 已完成，我现在准备收尾。",
      }),
    });

    expect(harness.apiClient.updateInteractiveCard).toHaveBeenCalledWith(
      "om_running_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务已完成",
          }),
        }),
      }),
    );
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.apiClient.replyTextMessage).not.toHaveBeenCalled();
    expect(harness.apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
    expect(harness.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
      threadId: "thread-native-1",
      activeRunKey: "thread-native-1:turn-1",
      status: "completed",
      messageId: "om_running_1",
      lastCompletionKey: "thread-native-1:completion-new",
      commandCount: 4,
    });
  });

  it("replies completion bridge assets to the frozen thread anchor after patching the running card", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "desktop-completion-thread-assets-"));
    const outputRoot = desktopCompletionOutputRoot();
    const imagePath = path.join(outputRoot, "thread-chart.png");
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(imagePath, "png");

    try {
      const harness = createHarness(harnesses, {
        threadCwd: cwd,
      });
      seedWatchState(harness.store, {
        threadId: "thread-native-1",
        lastNotifiedCompletionKey: "thread-native-1:notified-old",
      });
      harness.store.upsertCodexThreadDesktopNotificationState({
        threadId: "thread-native-1",
        activeRunKey: "thread-native-1:turn-1",
        status: "running_notified",
        startedAt: "2026-04-22T10:00:00.000Z",
        lastEventAt: "2026-04-22T10:00:06.000Z",
        messageId: "om_running_thread_1",
        deliveryMode: "thread",
        chatId: "oc_group_1",
        surfaceType: "thread",
        surfaceRef: "omt_topic_1",
        anchorMessageId: "om_anchor_thread_1",
        latestPublicMessage: "Task 1 已 review 完。",
        commandCount: 3,
        lastRenderHash: "render-1",
      });

      await harness.notifier.publishCompletion({
        completion: createCompletion({
          finalAssistantText: [
            "线程里的结果已完成。",
            "[bridge-image]",
              JSON.stringify({
                images: [
                  { path: imagePath, caption: "线程结果图" },
                ],
              }),
            "[/bridge-image]",
          ].join("\n"),
        }),
      });

      expect(harness.apiClient.updateInteractiveCard).toHaveBeenCalledWith(
        "om_running_thread_1",
        expect.any(Object),
      );
      expect(harness.apiClient.uploadImage).toHaveBeenCalledWith({
        imagePath,
      });
      expect(harness.apiClient.replyImageMessage).toHaveBeenCalledWith("om_anchor_thread_1", "img_desktop_1");
      expect(harness.apiClient.sendImageMessage).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to the last real user prompt when snapshot and recent conversation contain synthetic wrappers", async () => {
    const harness = createHarness(harnesses, {
      codexCatalogOverrides: {
        getDesktopDisplaySnapshot: vi.fn(() => ({
          lastHumanUserText: "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
        })),
        listRecentConversation: vi.fn(() => [
          {
            role: "user" as const,
            text: "请继续整理 Obsidian 入库流水线的实现方案。",
            timestamp: "2026-04-22T15:26:00.000Z",
          },
          {
            role: "user" as const,
            text: "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
            timestamp: "2026-04-22T15:26:18.000Z",
          },
        ]),
      },
    });
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });

    await harness.notifier.publishRunning({
      threadId: "thread-native-1",
      progress: createProgressSnapshot(),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    const card = harness.apiClient.sendInteractiveCard.mock.calls[0]?.[1] as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const markdownContent = (card.body?.elements ?? [])
      .map(element => element.content ?? "")
      .join("\n");

    expect(markdownContent).toContain("请继续整理 Obsidian 入库流水线的实现方案。");
    expect(markdownContent).not.toContain("The user interrupted the previous turn on purpose.");
  });

  it("posts to the project-group timeline without reusing stale Feishu topic context", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });
    seedThreadBinding(harness.store, {
      threadId: "thread-native-1",
      projectId: "project-key-1",
      chatId: "oc_group_1",
      feishuThreadId: "omt_topic_1",
      anchorMessageId: "om_anchor_topic_1",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "项目群里的结果已经就位。",
      }),
      target: {
        mode: "project_group",
        chatId: "oc_group_1",
      },
    });

    const notificationCard = harness.apiClient.sendInteractiveCardToChat.mock.calls[0]?.[1] as Record<string, unknown>;
    const notificationButtons = collectButtons(notificationCard);

    expect(harness.apiClient.sendInteractiveCardToChat).toHaveBeenCalledWith(
      "oc_group_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务已完成",
          }),
        }),
      }),
    );
    expect(harness.apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    expect(notificationButtons).toEqual([
      expect.objectContaining({
        label: "在飞书继续",
        type: "primary",
        value: expect.objectContaining({
          mode: "project_group",
          chatId: "oc_group_1",
        }),
      }),
    ]);
    expect(notificationButtons[0]?.value).toEqual(
      expect.not.objectContaining({
        surfaceType: expect.anything(),
        surfaceRef: expect.anything(),
      }),
    );
    expect(harness.apiClient.replyTextMessage).not.toHaveBeenCalled();
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
    expect(harness.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
      deliveryMode: "project_group",
      chatId: "oc_group_1",
      surfaceType: null,
      surfaceRef: null,
      anchorMessageId: null,
    });
  });

  it("delivers completion bridge assets directly to a project group chat", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "desktop-completion-group-assets-"));
    const outputRoot = desktopCompletionOutputRoot();
    const imagePath = path.join(outputRoot, "group-chart.png");
    const filePath = path.join(outputRoot, "group-report.md");
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(imagePath, "png");
    writeFileSync(filePath, "# group report\n");

    try {
      const harness = createHarness(harnesses, {
        threadCwd: cwd,
      });
      seedWatchState(harness.store, {
        threadId: "thread-native-1",
      });

      await harness.notifier.publish({
        completion: createCompletion({
          finalAssistantText: [
            "项目群里的资源已生成。",
            "[bridge-assets]",
            JSON.stringify({
                assets: [
                  { kind: "image", path: imagePath },
                  { kind: "file", path: filePath, file_name: "group-report.md" },
                ],
              }),
            "[/bridge-assets]",
          ].join("\n"),
        }),
        target: {
          mode: "project_group",
          chatId: "oc_group_1",
        },
      });

      expect(harness.apiClient.uploadImage).toHaveBeenCalledWith({
        imagePath,
      });
      expect(harness.apiClient.sendImageMessageToChat).toHaveBeenCalledWith("oc_group_1", "img_desktop_1");
      expect(harness.apiClient.uploadFile).toHaveBeenCalledWith({
        filePath,
        fileName: "group-report.md",
        fileType: undefined,
        duration: undefined,
      });
      expect(harness.apiClient.sendFileMessageToChat).toHaveBeenCalledWith("oc_group_1", "file_desktop_1");
      expect(harness.apiClient.replyImageMessage).not.toHaveBeenCalled();
      expect(harness.apiClient.replyFileMessage).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("posts a project-group notification card to the timeline without replying a second full result message", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "项目群里的完整结果也发好了。",
      }),
      target: {
        mode: "project_group",
        chatId: "oc_group_1",
      },
    });

    expect(harness.apiClient.sendInteractiveCardToChat).toHaveBeenCalledWith(
      "oc_group_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务已完成",
          }),
        }),
      }),
    );
    const notificationCard = harness.apiClient.sendInteractiveCardToChat.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(collectButtons(notificationCard)).toEqual([
      expect.objectContaining({
        label: "在飞书继续",
        type: "primary",
        value: expect.objectContaining({
          chatId: "oc_group_1",
        }),
      }),
    ]);
    expect(harness.apiClient.replyTextMessage).not.toHaveBeenCalled();
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
  });

  it("does not advance the notified key when the completion card itself fails to send", async () => {
    const harness = createHarness(harnesses, {
      apiClientOverrides: {
        sendInteractiveCard: vi.fn(async () => {
          throw new Error("FEISHU_DESKTOP_NOTIFICATION_SEND_FAILED");
        }),
      },
    });
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });

    await expect(harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "这条消息会发送失败。",
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    })).rejects.toThrow("FEISHU_DESKTOP_NOTIFICATION_SEND_FAILED");

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });
  });

  it("renders markdown-style final result directly inside the completion card", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: [
          "**明确待办**",
          "- 收尾桌面完成通知",
          "- 保持 Feishu markdown 卡回退策略一致",
        ].join("\n"),
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
    const notificationCard = harness.apiClient.sendInteractiveCard.mock.calls[0]?.[1] as Record<string, unknown>;
    const visibleText = collectVisibleText(notificationCard).join("\n");
    expect(harness.apiClient.sendInteractiveCard).toHaveBeenNthCalledWith(
      1,
      "ou_demo",
      expect.any(Object),
    );
    expect(visibleText).toContain("Codex 最终返回了什么");
    expect(visibleText).toContain("明确待办");
    expect(visibleText).toContain("收尾桌面完成通知");
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it("renders a non-empty body-unavailable fallback inside the completion card when final assistant text is empty", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
      lastNotifiedCompletionKey: "thread-native-1:notified-old",
    });

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: "   ",
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledWith(
      "ou_demo",
      expect.objectContaining({
        body: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              tag: "markdown",
              content: expect.stringContaining("body unavailable"),
            }),
          ]),
        }),
      }),
    );
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.store.getCodexThreadWatchState("thread-native-1")).toMatchObject({
      lastNotifiedCompletionKey: "thread-native-1:completion-new",
    });
  });

  it("reports invalid completion bridge assets visibly without leaking full local paths", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "desktop-completion-invalid-assets-"));

    try {
      const harness = createHarness(harnesses, {
        threadCwd: cwd,
      });
      seedWatchState(harness.store, {
        threadId: "thread-native-1",
      });

      await harness.notifier.publish({
        completion: createCompletion({
          finalAssistantText: [
            "[bridge-assets]",
            JSON.stringify({
              assets: [
                { kind: "file", path: "C:/Users/alice/private/secret.txt" },
              ],
            }),
            "[/bridge-assets]",
          ].join("\n"),
        }),
        target: {
          mode: "dm",
          peerId: "ou_demo",
        },
      });

      expect(harness.apiClient.uploadFile).not.toHaveBeenCalled();
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledTimes(1);
      const failureText = harness.apiClient.sendTextMessage.mock.calls[0]?.[1] ?? "";
      expect(failureText).toContain("secret.txt");
      expect(failureText).not.toContain("C:/Users/alice/private");
      expect(failureText).not.toContain("\\private\\");
      expect(harness.apiClient.sendInteractiveCard).toHaveBeenCalledWith(
        "ou_demo",
        expect.objectContaining({
          body: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "markdown",
                content: expect.stringContaining("body unavailable"),
              }),
            ]),
          }),
        }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("sends oversized completion images as files up to 30 MB and reports images above that visibly", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "desktop-completion-oversized-images-"));
    const outputRoot = desktopCompletionOutputRoot();
    const fileSizedImagePath = path.join(outputRoot, "large-chart.png");
    const tooLargeImagePath = path.join(outputRoot, "too-large-chart.png");
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(fileSizedImagePath, "");
    writeFileSync(tooLargeImagePath, "");
    truncateSync(fileSizedImagePath, 10 * 1024 * 1024 + 1);
    truncateSync(tooLargeImagePath, 30 * 1024 * 1024 + 1);

    try {
      const harness = createHarness(harnesses, {
        threadCwd: cwd,
      });
      seedWatchState(harness.store, {
        threadId: "thread-native-1",
      });

      await harness.notifier.publish({
        completion: createCompletion({
          finalAssistantText: [
            "两张图已生成。",
            "[bridge-assets]",
            JSON.stringify({
                assets: [
                  { kind: "image", path: fileSizedImagePath },
                  { kind: "image", path: tooLargeImagePath },
                ],
              }),
            "[/bridge-assets]",
          ].join("\n"),
        }),
        target: {
          mode: "dm",
          peerId: "ou_demo",
        },
      });

      expect(harness.apiClient.uploadImage).not.toHaveBeenCalled();
      expect(harness.apiClient.uploadFile).toHaveBeenCalledWith({
        filePath: fileSizedImagePath,
        fileName: "large-chart.png",
        fileType: undefined,
        duration: undefined,
      });
      expect(harness.apiClient.sendFileMessage).toHaveBeenCalledWith("ou_demo", "file_desktop_1");
      expect(harness.apiClient.sendTextMessage).toHaveBeenCalledWith(
        "ou_demo",
        expect.stringContaining("too-large-chart.png"),
      );
      const visibleFailureText = harness.apiClient.sendTextMessage.mock.calls
        .map(call => call[1])
        .join("\n");
      expect(visibleFailureText).toContain("超过 30 MB");
      expect(visibleFailureText).not.toContain(tooLargeImagePath);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps long completion content inside the completion card without a second text message", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });
    const longParagraph = [
      "这是一个很长的单段完成说明，用来验证通知卡不会把完整正文几乎原样塞进摘要区域。",
      "它会连续描述多个已经完成的动作，包括投递卡片、复用既有线程锚点、保持正文回退策略一致，以及更新通知去重状态。",
      "这里再追加一段关于提醒区总是展示最近用户上下文、线程标题回退和整体 payload guard 的说明，让单段摘要长度更接近真实场景。",
      "随后继续补充一段关于项目群根卡和首条回复配对关系的描述，把应该被裁掉的尾段标记推到更靠后的位置。",
      "最后这段尾巴只是为了制造明显的超长正文，并带上唯一标记：尾段标记不应完整出现在通知摘要中。",
    ].join("");

    await harness.notifier.publish({
      completion: createCompletion({
        finalAssistantText: longParagraph,
      }),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    });

    const notificationCard = harness.apiClient.sendInteractiveCard.mock.calls[0]?.[1] as Record<string, unknown>;
    const summaryMarkdown = findSummaryMarkdown(notificationCard);

    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
    expect(summaryMarkdown).toContain("**Codex 最终返回了什么**");
    expect(Buffer.byteLength(JSON.stringify(notificationCard), "utf8")).toBeLessThanOrEqual(30 * 1024);
  });

  it("refuses before sending when the watch-state row is missing", async () => {
    const harness = createHarness(harnesses);

    await expect(harness.notifier.publish({
      completion: createCompletion(),
      target: {
        mode: "dm",
        peerId: "ou_demo",
      },
    })).rejects.toThrow("FEISHU_DESKTOP_WATCH_STATE_NOT_FOUND");

    expect(harness.apiClient.sendInteractiveCard).not.toHaveBeenCalled();
    expect(harness.apiClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it("stores a running project-group route without re-reading a mutable topic binding", async () => {
    const harness = createHarness(harnesses);
    seedWatchState(harness.store, {
      threadId: "thread-native-1",
    });
    seedThreadBinding(harness.store, {
      threadId: "thread-native-1",
      projectId: "project-key-1",
      chatId: "oc_group_1",
      feishuThreadId: "omt_topic_1",
      anchorMessageId: "om_mutated_other_anchor",
    });

    await harness.notifier.publishRunning({
      threadId: "thread-native-1",
      progress: createProgressSnapshot(),
      target: {
        mode: "project_group",
        chatId: "oc_group_1",
      },
    });

    expect(harness.apiClient.sendInteractiveCardToChat).toHaveBeenCalledWith(
      "oc_group_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "桌面任务进行中",
          }),
        }),
      }),
    );
    expect(harness.apiClient.replyInteractiveCard).not.toHaveBeenCalled();
    expect(harness.apiClient.replyTextMessage).not.toHaveBeenCalled();
    expect(harness.store.getCodexThreadDesktopNotificationState("thread-native-1")).toMatchObject({
      deliveryMode: "project_group",
      chatId: "oc_group_1",
      surfaceType: null,
      surfaceRef: null,
      anchorMessageId: null,
    });
  });
});

interface NotifierHarness {
  rootDir: string;
  store: SessionStore;
  notifier: DesktopCompletionNotifier;
  apiClient: ReturnType<typeof createApiClientDouble>;
}

function createHarness(
  harnesses: NotifierHarness[],
  input?: {
    threadCwd?: string;
    apiClientOverrides?: Partial<ReturnType<typeof createApiClientDouble>>;
    codexCatalogOverrides?: Partial<{
      getThread: ReturnType<typeof vi.fn>;
      listRecentConversation: ReturnType<typeof vi.fn>;
      getDesktopDisplaySnapshot: ReturnType<typeof vi.fn>;
    }>;
  },
): NotifierHarness {
  const rootDir = mkdtempSync(path.join(tmpdir(), "desktop-completion-notifier-"));
  const store = new SessionStore(path.join(rootDir, "bridge.db"));
  const apiClient = createApiClientDouble(input?.apiClientOverrides);
  const codexCatalog = {
    getThread: vi.fn(() => ({
      threadId: "thread-native-1",
      projectKey: "project-key-1",
      cwd: input?.threadCwd ?? "D:/repo-one",
      displayName: "Repo One",
      title: "修复桌面完成通知",
      source: "user",
      archived: false,
      updatedAt: "2026-04-20T10:00:00.000Z",
      createdAt: "2026-04-20T09:00:00.000Z",
      gitBranch: "main",
      cliVersion: "0.0.0",
      rolloutPath: "D:/repo-one/.codex/rollout.jsonl",
    })),
    listRecentConversation: vi.fn(() => [
      {
        role: "assistant" as const,
        text: "上一轮 assistant 回复",
        timestamp: "2026-04-20T10:00:00.000Z",
      },
      {
        role: "user" as const,
        text: "请把完整结果发回飞书，并给一个清晰的通知卡。",
        timestamp: "2026-04-20T09:59:00.000Z",
      },
    ]),
    getDesktopDisplaySnapshot: vi.fn(() => ({
      lastHumanUserText: "请把完整结果发回飞书，并给一个清晰的通知卡。",
    })),
    ...input?.codexCatalogOverrides,
  };
  const notifier = new DesktopCompletionNotifier({
    apiClient: apiClient as any,
    store,
    codexCatalog: codexCatalog as any,
  });
  const harness = {
    rootDir,
    store,
    notifier,
    apiClient,
  };
  harnesses.push(harness);
  return harness;
}

function createApiClientDouble(
  overrides?: Partial<{
    sendTextMessage: ReturnType<typeof vi.fn>;
    sendTextMessageToChat: ReturnType<typeof vi.fn>;
    sendInteractiveCard: ReturnType<typeof vi.fn>;
    sendInteractiveCardToChat: ReturnType<typeof vi.fn>;
    replyTextMessage: ReturnType<typeof vi.fn>;
    replyInteractiveCard: ReturnType<typeof vi.fn>;
    updateInteractiveCard: ReturnType<typeof vi.fn>;
    uploadImage: ReturnType<typeof vi.fn>;
    sendImageMessage: ReturnType<typeof vi.fn>;
    replyImageMessage: ReturnType<typeof vi.fn>;
    sendImageMessageToChat: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
    sendFileMessage: ReturnType<typeof vi.fn>;
    replyFileMessage: ReturnType<typeof vi.fn>;
    sendFileMessageToChat: ReturnType<typeof vi.fn>;
  }>,
) {
  return {
    sendTextMessage: vi.fn(async () => "om_dm_text_1"),
    sendTextMessageToChat: vi.fn(async () => ({
      messageId: "om_group_text_1",
      threadId: "omt_group_text_1",
    })),
    sendInteractiveCard: vi.fn(async () => "om_dm_card_1"),
    sendInteractiveCardToChat: vi.fn(async () => ({
      messageId: "om_group_root_card_1",
      threadId: "omt_group_root_1",
    })),
    replyTextMessage: vi.fn(async () => "om_reply_text_1"),
    replyInteractiveCard: vi.fn(async () => "om_reply_card_1"),
    updateInteractiveCard: vi.fn(async () => undefined),
    uploadImage: vi.fn(async () => "img_desktop_1"),
    sendImageMessage: vi.fn(async () => "om_dm_image_1"),
    replyImageMessage: vi.fn(async () => "om_reply_image_1"),
    sendImageMessageToChat: vi.fn(async () => ({
      messageId: "om_group_image_1",
      threadId: "omt_group_image_1",
    })),
    uploadFile: vi.fn(async () => "file_desktop_1"),
    sendFileMessage: vi.fn(async () => "om_dm_file_1"),
    replyFileMessage: vi.fn(async () => "om_reply_file_1"),
    sendFileMessageToChat: vi.fn(async () => ({
      messageId: "om_group_file_1",
      threadId: "omt_group_file_1",
    })),
    ...overrides,
  };
}

function createCompletion(
  overrides?: Partial<CodexDesktopCompletionEvent>,
): CodexDesktopCompletionEvent {
  return {
    threadId: "thread-native-1",
    completedAt: "2026-04-20T12:00:00.000Z",
    finalAssistantText: "任务已经处理完成。",
    completionKey: "thread-native-1:completion-new",
    ...overrides,
  };
}

function desktopCompletionOutputRoot(): string {
  return path.join(
    tmpdir(),
    "coding-anywhere",
    "desktop-completion-outbound",
    "thread-native-1",
    "thread-native-1_completion-new",
  );
}

function createProgressSnapshot(
  overrides?: Partial<CodexDesktopProgressSnapshot>,
): CodexDesktopProgressSnapshot {
  return {
    runKey: "thread-native-1:turn-1",
    startedAt: "2026-04-22T10:00:00.000Z",
    lastEventAt: "2026-04-22T10:00:06.000Z",
    latestPublicMessage: "Task 1 已 review 完，我现在补测试和文档。",
    planTodos: [
      { text: "Task 1: Review implementation", completed: true },
      { text: "Task 2: Add tests", completed: false },
    ],
    commandCount: 3,
    ...overrides,
  };
}

function seedWatchState(
  store: SessionStore,
  input: {
    threadId: string;
    lastNotifiedCompletionKey?: string | null;
  },
): void {
  store.upsertCodexThreadWatchState({
    threadId: input.threadId,
    rolloutPath: `D:/codex/${input.threadId}.jsonl`,
    rolloutMtime: "2026-04-20T11:59:00.000Z",
    lastReadOffset: 256,
    lastCompletionKey: "thread-native-1:completion-old",
    lastNotifiedCompletionKey: input.lastNotifiedCompletionKey ?? null,
  });
}

function seedThreadBinding(
  store: SessionStore,
  input: {
    threadId: string;
    projectId: string;
    chatId: string;
    feishuThreadId: string;
    anchorMessageId: string;
  },
): void {
  store.createProject({
    projectId: input.projectId,
    name: "Repo One",
    cwd: "D:/repo-one",
    repoRoot: "D:/repo-one",
    createdAt: "2026-04-20T09:00:00.000Z",
    updatedAt: "2026-04-20T09:00:00.000Z",
  });
  store.createCodexThread({
    threadId: input.threadId,
    projectId: input.projectId,
    feishuThreadId: input.feishuThreadId,
    chatId: input.chatId,
    anchorMessageId: input.anchorMessageId,
    latestMessageId: input.anchorMessageId,
    sessionName: input.threadId,
    title: "修复桌面完成通知",
    ownerOpenId: "ou_demo",
    status: "warm",
    createdAt: "2026-04-20T09:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    lastActivityAt: "2026-04-20T10:00:00.000Z",
    archivedAt: null,
    lastRunId: null,
  });
}

function collectButtons(card: Record<string, unknown>): Array<{
  label: string;
  type: string;
  value?: Record<string, unknown>;
}> {
  const buttons: Array<{
    label: string;
    type: string;
    value?: Record<string, unknown>;
  }> = [];

  visit(card);
  return buttons;

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    const candidate = node as {
      tag?: unknown;
      type?: unknown;
      text?: {
        content?: unknown;
      };
      value?: Record<string, unknown>;
    };

    if (candidate.tag === "button") {
      buttons.push({
        label: typeof candidate.text?.content === "string" ? candidate.text.content : "",
        type: typeof candidate.type === "string" ? candidate.type : "default",
        value: candidate.value,
      });
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  }
}

function collectVisibleText(card: Record<string, unknown>): string[] {
  const text: string[] = [];
  visit(card);
  return text;

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    const candidate = node as {
      content?: unknown;
      text?: {
        content?: unknown;
      };
      elements?: unknown;
    };

    if (typeof candidate.content === "string") {
      text.push(candidate.content);
    }
    if (typeof candidate.text?.content === "string") {
      text.push(candidate.text.content);
    }

    for (const value of Object.values(candidate)) {
      visit(value);
    }
  }
}

function findSummaryMarkdown(card: Record<string, unknown>): string {
  const markdownBlocks = collectMarkdownBlocks(card);
  return markdownBlocks.find(block => block.includes("Codex 最终返回了什么")) ?? "";
}

function collectMarkdownBlocks(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(item => collectMarkdownBlocks(item));
  }

  if (!node || typeof node !== "object") {
    return [];
  }

  const candidate = node as {
    tag?: unknown;
    content?: unknown;
  };

  const current = candidate.tag === "markdown" && typeof candidate.content === "string"
    ? [candidate.content]
    : [];

  return [
    ...current,
    ...Object.values(node).flatMap(value => collectMarkdownBlocks(value)),
  ];
}
