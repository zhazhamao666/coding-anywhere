import { describe, expect, it } from "vitest";

import { createProgressCardState, reduceProgressEvent } from "../src/progress-relay.js";

describe("progress relay reducer", () => {
  it("maps CA lifecycle updates into preparing states", () => {
    const state = createProgressCardState({
      runId: "run-1",
      rootName: "main",
    });

    const next = reduceProgressEvent(state, {
      type: "bridge_lifecycle",
      stage: "ensuring_session",
      content: "[ca] ensuring session",
      sessionName: "codex-main",
    });

    expect(next.stage).toBe("ensuring_session");
    expect(next.status).toBe("preparing");
    expect(next.preview).toBe("[ca] ensuring session");
  });

  it("marks tool activity without generating synthetic summaries", () => {
    const state = createProgressCardState({
      runId: "run-1",
      rootName: "main",
    });

    const next = reduceProgressEvent(state, {
      type: "tool_call",
      toolName: "npm test",
      content: "npm test",
    });

    expect(next.status).toBe("tool_active");
    expect(next.stage).toBe("tool_call");
    expect(next.latestTool).toBe("npm test");
    expect(next.preview).toBe("[ca] tool_call: npm test");
  });
});
