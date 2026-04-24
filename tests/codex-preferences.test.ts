import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getCodexModelLabel,
  getFallbackCodexPreferenceCatalog,
  resolveCodexPreferenceCatalog,
} from "../src/codex-preferences.js";

describe("codex preferences", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("orders newer GPT models before older known models and keeps custom models after GPT models", () => {
    const catalog = resolveCodexPreferenceCatalog({
      command: "codex",
      defaultModel: "gpt-5.4",
      defaultReasoningEffort: undefined,
      defaultSpeed: undefined,
      modelOptions: [
        "codex-MiniMax-M2.5",
        "gpt-5.5",
        "gpt-5.6-codex-max",
        "GPT-5.5",
        "gpt-5.3-codex",
      ],
      reasoningEffortOptions: [],
      speedOptions: [],
    }, {
      codexHomePath: createCodexHome(),
    });

    expect(catalog.modelOptions.indexOf("gpt-5.6-codex-max"))
      .toBeLessThan(catalog.modelOptions.indexOf("gpt-5.5"));
    expect(catalog.modelOptions.indexOf("gpt-5.5"))
      .toBeLessThan(catalog.modelOptions.indexOf("gpt-5.4"));
    expect(catalog.modelOptions.indexOf("gpt-5.4"))
      .toBeLessThan(catalog.modelOptions.indexOf("gpt-5.3-codex"));
    expect(catalog.modelOptions.filter(model => model === "gpt-5.5")).toHaveLength(1);
    expect(catalog.modelOptions.at(-1)).toBe("codex-MiniMax-M2.5");
  });

  it("formats GPT model labels consistently even when a model was not pre-registered", () => {
    expect(getCodexModelLabel("gpt-5.5")).toBe("GPT-5.5");
    expect(getCodexModelLabel("gpt-5.6-codex-max")).toBe("GPT-5.6-Codex-Max");
    expect(getCodexModelLabel("gpt-5.4-mini")).toBe("GPT-5.4-Mini");
    expect(getCodexModelLabel("codex-MiniMax-M2.5")).toBe("Codex-MiniMax-M2.5");
  });

  it("keeps the fallback model list in stable newest-first order", () => {
    const fallback = getFallbackCodexPreferenceCatalog();

    expect(fallback.modelOptions[0]).toBe("gpt-5.5");
    expect(fallback.modelOptions.indexOf("gpt-5.5"))
      .toBeLessThan(fallback.modelOptions.indexOf("gpt-5.4"));
    expect(fallback.modelOptions.indexOf("gpt-5.4"))
      .toBeLessThan(fallback.modelOptions.indexOf("gpt-5.4-mini"));
  });

  it("canonicalizes model hints discovered from local Codex config profiles", () => {
    const catalog = resolveCodexPreferenceCatalog({
      command: "codex",
      defaultModel: undefined,
      defaultReasoningEffort: undefined,
      defaultSpeed: undefined,
      modelOptions: [],
      reasoningEffortOptions: [],
      speedOptions: [],
    }, {
      codexHomePath: createCodexHome(`
model = "GPT-5.5"

[profiles.next]
model = "GPT-5.6-Codex-Max"

[profiles.duplicate]
model = "gpt-5.5"
`),
    });

    expect(catalog.defaultModel).toBe("gpt-5.5");
    expect(catalog.modelOptions.indexOf("gpt-5.6-codex-max"))
      .toBeLessThan(catalog.modelOptions.indexOf("gpt-5.5"));
    expect(catalog.modelOptions.filter(model => model === "gpt-5.5")).toHaveLength(1);
  });

  function createCodexHome(config = ""): string {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-preferences-"));
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.toml"), config, "utf8");
    return dir;
  }
});
