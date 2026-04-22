import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveFeishuAssistantMessageDelivery } from "../src/feishu-assistant-message.js";

describe("Feishu assistant message delivery", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("hides git directives and appends a compact changed-file summary for committed changes", () => {
    const repoDir = createGitRepo(tempDirs, "assistant-delivery-commit");
    writeFileSync(path.join(repoDir, "alpha.txt"), "alpha\n", "utf8");
    writeFileSync(path.join(repoDir, "beta.txt"), "beta\n", "utf8");
    git(repoDir, ["add", "alpha.txt", "beta.txt"]);
    git(repoDir, ["commit", "-m", "feat: add two files"]);

    const delivery = resolveFeishuAssistantMessageDelivery([
      "都通过了。当前分支就是 main，提交是 abc123。",
      "",
      `::git-stage{cwd="${repoDir.replace(/\\/g, "/")}"}`,
      `::git-commit{cwd="${repoDir.replace(/\\/g, "/")}"}`,
    ].join("\n"));

    const visible = extractVisibleText(delivery);
    expect(visible).toContain("都通过了。当前分支就是 main，提交是 abc123。");
    expect(visible).toContain("2 个文件已更改");
    expect(visible).not.toContain("alpha.txt");
    expect(visible).not.toContain("beta.txt");
    expect(visible).not.toContain("::git-stage");
    expect(visible).not.toContain("::git-commit");
    expect(visible).not.toContain("+");
  });

  it("uses staged file count for git-stage only and falls back gracefully when inspection is impossible", () => {
    const repoDir = createGitRepo(tempDirs, "assistant-delivery-stage");
    writeFileSync(path.join(repoDir, "gamma.txt"), "gamma\n", "utf8");
    git(repoDir, ["add", "gamma.txt"]);

    const delivery = resolveFeishuAssistantMessageDelivery([
      "我已经把改动整理好了。",
      `::git-stage{cwd="${repoDir.replace(/\\/g, "/")}"}`,
      "::git-stage{cwd=\"D:/not-a-real-repo\"}",
    ].join("\n"));

    const visible = extractVisibleText(delivery);
    expect(visible).toContain("我已经把改动整理好了。");
    expect(visible).toContain("1 个文件已更改");
    expect(visible).not.toContain("gamma.txt");
    expect(visible).not.toContain("::git-stage");
    expect(visible).not.toContain("D:/not-a-real-repo");
  });
});

function createGitRepo(tempDirs: string[], prefix: string): string {
  const repoDir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  tempDirs.push(repoDir);
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.name", "Codex Test"]);
  git(repoDir, ["config", "user.email", "codex@example.com"]);
  return repoDir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

function extractVisibleText(
  delivery: ReturnType<typeof resolveFeishuAssistantMessageDelivery>,
): string {
  return delivery.kind === "card"
    ? JSON.stringify(delivery.card)
    : delivery.text;
}
