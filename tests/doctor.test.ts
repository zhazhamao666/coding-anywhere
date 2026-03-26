import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectEnvironment } from "../src/doctor.js";

describe("inspectEnvironment", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-doctor-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("flags placeholder feishu credentials and allowlist entries as blocking issues", () => {
    const configPath = path.join(rootDir, "config.toml");
    writeFileSync(
      configPath,
      `
[server]
host = "127.0.0.1"
port = 3000

[storage]
sqlitePath = "data/bridge.db"
logDir = "logs"

[acpx]
command = "acpx"
agent = "codex"

[feishu]
appId = "cli_xxx"
appSecret = "replace-me"
websocketUrl = "wss://open.feishu.cn/open-apis/bot/v2/hub"
apiBaseUrl = "https://open.feishu.cn/open-apis"
allowlist = ["ou_xxx"]

[root]
id = "main"
name = "Main Root"
cwd = "D:/repos"
repoRoot = "D:/repos"
branchPolicy = "reuse"
permissionMode = "workspace-write"
envAllowlist = ["PATH"]
idleTtlHours = 24
`,
      "utf8",
    );

    const report = inspectEnvironment({
      cwd: rootDir,
      configPath,
      resolveCommand: command => (command === "codex" ? "C:/bin/codex.cmd" : "C:/bin/acpx.cmd"),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.filter(check => !check.ok).map(check => check.id)).toEqual([
      "feishu.appId",
      "feishu.appSecret",
      "feishu.allowlist",
      "root.cwd",
    ]);
  });
});
