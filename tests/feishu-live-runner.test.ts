import { describe, expect, it } from "vitest";

// @ts-expect-error The live runner is an executable .mjs script with testable named exports.
import { buildFeishuLivePlaywrightCommand, normalizeScenarios, normalizeSurface } from "../scripts/feishu-live.mjs";

describe("feishu live runner", () => {
  it("normalizes live surfaces to dm or group", () => {
    expect(normalizeSurface(undefined)).toBe("dm");
    expect(normalizeSurface("group")).toBe("group");
    expect(normalizeSurface(" GROUP ")).toBe("group");
    expect(normalizeSurface("dm")).toBe("dm");
    expect(normalizeSurface("other")).toBe("dm");
  });

  it("rejects topic because live UI autotest currently supports only dm and group", () => {
    expect(() => normalizeSurface("topic")).toThrowError(
      "[ca] Feishu live surface `topic` is not supported by the current autotest fixture. Use `dm` or `group`.",
    );
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
