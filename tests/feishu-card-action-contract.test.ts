import { describe, expect, it } from "vitest";

import * as actionContract from "../src/feishu-card/action-contract.js";

describe("feishu card action contract", () => {
  it("builds command action values with surface context", () => {
    expect(actionContract.buildCommandActionValue({
      command: "/ca status",
      context: {
        chatId: "oc_chat_current",
        surfaceType: "thread",
        surfaceRef: "omt_current",
      },
    })).toEqual({
      actionKind: "command_action",
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

    expect(actionContract.buildPreferenceActionValue(context, "set_codex_model")).toEqual({
      actionKind: "preference_action",
      bridgeAction: "set_codex_model",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
    expect(actionContract.buildPlanChoiceActionValue({
      interactionId: "plan-1",
      choiceId: "tests",
      context,
    })).toEqual({
      actionKind: "plan_choice_action",
      bridgeAction: "answer_plan_choice",
      interactionId: "plan-1",
      choiceId: "tests",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
  });

  it("builds plan mode and diagnostics actions with surface context", () => {
    const context = {
      chatId: "oc_chat_current",
      surfaceType: "thread" as const,
      surfaceRef: "omt_current",
    };

    const buildPlanModeToggleActionValue = (actionContract as any).buildPlanModeToggleActionValue;
    const buildOpenDiagnosticsActionValue = (actionContract as any).buildOpenDiagnosticsActionValue;
    const buildCloseDiagnosticsActionValue = (actionContract as any).buildCloseDiagnosticsActionValue;

    expect(typeof buildPlanModeToggleActionValue).toBe("function");
    expect(buildPlanModeToggleActionValue?.(context)).toEqual({
      actionKind: "session_ui_action",
      bridgeAction: "toggle_plan_mode",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });

    expect(typeof buildOpenDiagnosticsActionValue).toBe("function");
    expect(buildOpenDiagnosticsActionValue?.(context)).toEqual({
      actionKind: "session_ui_action",
      bridgeAction: "open_diagnostics",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });

    expect(typeof buildCloseDiagnosticsActionValue).toBe("function");
    expect(buildCloseDiagnosticsActionValue?.(context)).toEqual({
      actionKind: "session_ui_action",
      bridgeAction: "close_diagnostics",
      chatId: "oc_chat_current",
      surfaceType: "thread",
      surfaceRef: "omt_current",
    });
  });

  it("builds desktop continuation actions without leaking empty optional fields", () => {
    expect(actionContract.buildDesktopThreadActionValue("continue_desktop_thread", {
      threadId: "thread-native-1",
      mode: "dm",
    })).toEqual({
      actionKind: "continue_thread_action",
      bridgeAction: "continue_desktop_thread",
      threadId: "thread-native-1",
      mode: "dm",
      chatType: "p2p",
    });
  });
});
