import { describe, expect, it } from "vitest";

import { parseCodexAppDirectives } from "../src/codex-app-directive.js";

describe("codex app directive parser", () => {
  it("removes top-level git directive lines from visible text and returns structured metadata", () => {
    const parsed = parseCodexAppDirectives([
      "都通过了。当前分支就是 main。",
      "",
      "::git-stage{cwd=\"D:/repo-one\"}",
      "::git-commit{cwd=\"D:/repo-one\"}",
    ].join("\n"));

    expect(parsed.visibleText).toBe("都通过了。当前分支就是 main。");
    expect(parsed.directives).toEqual([
      {
        name: "git-stage",
        attributes: {
          cwd: "D:/repo-one",
        },
        rawLine: "::git-stage{cwd=\"D:/repo-one\"}",
      },
      {
        name: "git-commit",
        attributes: {
          cwd: "D:/repo-one",
        },
        rawLine: "::git-commit{cwd=\"D:/repo-one\"}",
      },
    ]);
  });

  it("does not treat malformed or inline directive-like text as hidden metadata", () => {
    const parsed = parseCodexAppDirectives([
      "这里有一段普通文本 ::git-stage{cwd=\"D:/repo-one\"}，它不是独占一行。",
      "::git-stage{cwd=\"D:/repo-one\"",
      "",
      "```text",
      "::git-commit{cwd=\"D:/repo-one\"}",
      "```",
    ].join("\n"));

    expect(parsed.visibleText).toContain("这里有一段普通文本 ::git-stage{cwd=\"D:/repo-one\"}，它不是独占一行。");
    expect(parsed.visibleText).toContain("::git-stage{cwd=\"D:/repo-one\"");
    expect(parsed.visibleText).toContain("::git-commit{cwd=\"D:/repo-one\"}");
    expect(parsed.directives).toEqual([]);
  });
});
