import { describe, expect, it } from "vitest";

import { routeBridgeInput } from "../src/command-router.js";

describe("routeBridgeInput", () => {
  it("passes non-command messages through without modification", () => {
    const result = routeBridgeInput("请帮我检查当前项目的测试失败原因");

    expect(result).toEqual({
      kind: "prompt",
      prompt: "请帮我检查当前项目的测试失败原因",
    });
  });

  it("treats deprecated repo commands as bridge help requests", () => {
    const result = routeBridgeInput("/ca repo use demo");

    expect(result).toEqual({
      kind: "command",
      command: {
        name: "help",
        args: ["use", "demo"],
      },
    });
  });

  it("routes project and thread commands with their subcommands intact", () => {
    expect(routeBridgeInput("/ca project bind proj-a oc_chat_1 coding-anywhere Demo Project")).toEqual({
      kind: "command",
      command: {
        name: "project",
        args: ["bind", "proj-a", "oc_chat_1", "coding-anywhere", "Demo", "Project"],
      },
    });

    expect(routeBridgeInput("/ca thread create proj-a feishu nav")).toEqual({
      kind: "command",
      command: {
        name: "thread",
        args: ["create", "proj-a", "feishu", "nav"],
      },
    });
  });
});
