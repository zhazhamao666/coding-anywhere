import { describe, expect, it, vi } from "vitest";

import { StreamingCardController } from "../src/feishu-card/streaming-card-controller.js";
import type { ProgressCardState } from "../src/types.js";

describe("StreamingCardController", () => {
  it("uses the CardKit path when available and finalizes on completion", async () => {
    const apiClient = createApiClientDouble();
    const controller = new StreamingCardController({
      peerId: "ou_demo",
      apiClient,
    });

    await controller.push(createState({
      status: "queued",
      stage: "received",
      preview: "[ca] received",
    }));
    await controller.push(createState({
      status: "tool_active",
      stage: "tool_call",
      latestTool: "npm test",
      preview: "[ca] tool_call: npm test",
    }));
    await controller.push(createState({
      status: "done",
      stage: "done",
      preview: "任务完成",
      elapsedMs: 4_000,
    }));

    expect(apiClient.createCardEntity).toHaveBeenCalledTimes(1);
    expect(apiClient.sendCardKitMessage).toHaveBeenCalledWith("ou_demo", "card-1");
    expect(apiClient.streamCardElement).toHaveBeenCalled();
    expect(apiClient.setCardStreamingMode).toHaveBeenCalledWith("card-1", false, expect.any(Number));
    expect(apiClient.updateCardKitCard).toHaveBeenCalledWith(
      "card-1",
      expect.objectContaining({
        schema: "2.0",
      }),
      expect.any(Number),
    );
    expect(apiClient.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it("falls back to interactive card patch updates when CardKit initialization fails", async () => {
    const apiClient = createApiClientDouble({
      createCardEntity: vi.fn(async () => {
        throw new Error("CARDKIT_UNAVAILABLE");
      }),
    });
    const controller = new StreamingCardController({
      peerId: "ou_demo",
      apiClient,
    });

    await controller.push(createState({
      status: "queued",
      stage: "received",
      preview: "[ca] received",
    }));
    await controller.push(createState({
      status: "running",
      stage: "text",
      preview: "正在输出",
    }));
    await controller.push(createState({
      status: "done",
      stage: "done",
      preview: "任务完成",
      elapsedMs: 3_000,
    }));

    expect(apiClient.sendInteractiveCard).toHaveBeenCalledWith(
      "ou_demo",
      expect.objectContaining({
        schema: "2.0",
      }),
    );
    expect(apiClient.updateInteractiveCard).toHaveBeenCalled();
    expect(apiClient.sendCardKitMessage).not.toHaveBeenCalled();
  });

  it("finalizes the card as error when requested explicitly", async () => {
    const apiClient = createApiClientDouble();
    const controller = new StreamingCardController({
      peerId: "ou_demo",
      apiClient,
    });

    await controller.push(createState({
      status: "queued",
      stage: "received",
      preview: "[ca] received",
    }));
    await controller.finalizeError("[ca] error: SESSION_INIT_FAILED");

    expect(apiClient.updateCardKitCard).toHaveBeenCalledWith(
      "card-1",
      expect.objectContaining({
        schema: "2.0",
      }),
      expect.any(Number),
    );
  });
});

function createState(overrides?: Partial<ProgressCardState>): ProgressCardState {
  return {
    runId: "run-1",
    rootName: "main",
    sessionName: "codex-main",
    status: "queued",
    stage: "received",
      preview: "[ca] queued",
    startedAt: 1_000,
    elapsedMs: 0,
    ...overrides,
  };
}

function createApiClientDouble(overrides?: Record<string, unknown>) {
  return {
    sendTextMessage: vi.fn(async () => "msg-text-1"),
    sendTextMessageToChat: vi.fn(async () => ({ messageId: "msg-chat-1", threadId: "omt-1" })),
    replyTextMessage: vi.fn(async () => "msg-reply-text-1"),
    updateTextMessage: vi.fn(async () => undefined),
    sendInteractiveCard: vi.fn(async () => "msg-card-1"),
    replyInteractiveCard: vi.fn(async () => "msg-reply-card-1"),
    updateInteractiveCard: vi.fn(async () => undefined),
    createCardEntity: vi.fn(async () => "card-1"),
    sendCardKitMessage: vi.fn(async () => "msg-cardkit-1"),
    streamCardElement: vi.fn(async () => undefined),
    setCardStreamingMode: vi.fn(async () => undefined),
    updateCardKitCard: vi.fn(async () => undefined),
    ...overrides,
  };
}
