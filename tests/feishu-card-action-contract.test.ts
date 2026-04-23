import { describe, expect, it } from "vitest";

import {
  buildCommandActionValue,
  buildDesktopThreadActionValue,
  buildPlanChoiceActionValue,
  buildPlanFormActionValue,
  buildPreferenceActionValue,
} from "../src/feishu-card/action-contract.js";

describe("feishu card action contract", () => {
  it("builds command action values with surface context", () => {
    expect(buildCommandActionValue({
      command: "/ca status",
      context: {
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
      },
    })).toEqual({
      command: "/ca status",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
  });

  it("builds bridge action values for plan and preference callbacks", () => {
    const context = {
      chatId: "oc_chat_current",
      surfaceType: "thread" as const,
      surfaceRef: "omt_current",
    };

    expect(buildPlanFormActionValue(context)).toEqual({
      bridgeAction: "open_plan_form",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(buildPreferenceActionValue(context, "set_codex_model")).toEqual({
      bridgeAction: "set_codex_model",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(buildPlanChoiceActionValue({
      interactionId: "plan-1",
      choiceId: "tests",
      context,
    })).toEqual({
      bridgeAction: "answer_plan_choice",
      interactionId: "plan-1",
      choiceId: "tests",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
  });

  it("builds desktop continuation actions without leaking empty optional fields", () => {
    expect(buildDesktopThreadActionValue("continue_desktop_thread", {
      threadId: "thread-native-1",
      mode: "dm",
    })).toEqual({
      bridgeAction: "continue_desktop_thread",
      threadId: "thread-native-1",
      mode: "dm",
    });
  });
});
