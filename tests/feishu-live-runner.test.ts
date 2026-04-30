import { describe, expect, it } from "vitest";

// @ts-expect-error The live runner is an executable .mjs script with testable named exports.
import { buildFeishuLivePlaywrightCommand, normalizeScenarios, normalizeSurface } from "../scripts/feishu-live.mjs";

describe("feishu live runner", () => {
  it("normalizes live surfaces to dm, group, or topic", () => {
    expect(normalizeSurface(undefined)).toBe("dm");
    expect(normalizeSurface("group")).toBe("group");
    expect(normalizeSurface(" GROUP ")).toBe("group");
    expect(normalizeSurface("topic")).toBe("topic");
    expect(normalizeSurface("dm")).toBe("dm");
    expect(normalizeSurface("other")).toBe("dm");
  });

  it("normalizes comma separated live UI scenarios", () => {
    expect(normalizeScenarios(undefined)).toBeUndefined();
    expect(normalizeScenarios(" main, diagnostics ,, ops-ui ")).toBe("main,diagnostics,ops-ui");
  });

  it("uses npm exec to launch Playwright on Windows", () => {
    const command = buildFeishuLivePlaywrightCommand("win32");

    expect(command.file).toBe("cmd.exe");
    expect(command.args).toEqual([
      "/d",
      "/s",
      "/c",
      "npm exec -- playwright test -c playwright.config.ts --project=feishu-live",
    ]);
  });
});
