import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectEnvironment } from "../src/doctor.js";

describe("inspectEnvironment", () => {
  let rootDir: string;
  let configPath: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-doctor-"));
    configPath = path.join(rootDir, "config.toml");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("flags placeholder feishu credentials and allowlist entries as blocking issues without requiring acpx", () => {
    writeFileSync(
      configPath,
      createConfigToml({
        appId: "cli_xxx",
        appSecret: "replace-me",
        allowlist: ["ou_xxx"],
        rootCwd: "D:/repos",
      }),
      "utf8",
    );

    const report = inspectEnvironment({
      cwd: rootDir,
      configPath,
      resolveCommand: command => (command === "codex" ? "C:/bin/codex.cmd" : undefined),
    });

    expect(report.ok).toBe(false);
    expect(
      report.checks
        .filter(check => check.severity === "blocking" && !check.ok)
        .map(check => check.id),
    ).toEqual([
      "feishu.appId",
      "feishu.appSecret",
      "feishu.allowlist",
      "root.cwd",
    ]);
  });

  it("warns when the config still uses the legacy acpx section name", () => {
    writeFileSync(
      configPath,
      createConfigToml({
        appId: "cli_real",
        appSecret: "secret-real",
        allowlist: ["ou_real"],
        rootCwd: rootDir,
        runnerSection: "acpx",
      }),
      "utf8",
    );

    const report = inspectEnvironment({
      cwd: rootDir,
      configPath,
      resolveCommand: command => (command === "codex" ? "C:/bin/codex.cmd" : undefined),
    });

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config.legacyAcpxSection",
          ok: false,
          severity: "warning",
        }),
      ]),
    );
  });

  it("warns that real codex smoke needs auth and explicit opt-in guidance", () => {
    const codexHome = path.join(rootDir, ".codex");
    writeFileSync(
      configPath,
      createConfigToml({
        appId: "cli_real",
        appSecret: "secret-real",
        allowlist: ["ou_real"],
        rootCwd: rootDir,
      }),
      "utf8",
    );

    const report = inspectEnvironment({
      cwd: rootDir,
      configPath,
      codexHomePath: codexHome,
      resolveCommand: command => (command === "codex" ? "C:/bin/codex.cmd" : undefined),
    });

    expect(report.ok).toBe(true);
    expect(
      report.checks.filter(check => check.severity === "warning" && !check.ok).map(check => check.id),
    ).toEqual([
      "codex.realSmokeAuth",
      "codex.realSmokeOptIn",
    ]);
  });
});

function createConfigToml(input: {
  appId: string;
  appSecret: string;
  allowlist: string[];
  rootCwd: string;
  runnerSection?: "codex" | "acpx";
}) {
  const runnerSection = input.runnerSection ?? "codex";
  const runnerCommand = runnerSection === "codex" ? "codex" : "acpx";

  return `
[server]
host = "127.0.0.1"
port = 3000

[storage]
sqlitePath = "data/bridge.db"
logDir = "logs"

[${runnerSection}]
command = "${runnerCommand}"

[feishu]
appId = "${input.appId}"
appSecret = "${input.appSecret}"
websocketUrl = "wss://open.feishu.cn/open-apis/bot/v2/hub"
apiBaseUrl = "https://open.feishu.cn/open-apis"
allowlist = [${input.allowlist.map(value => `"${value}"`).join(", ")}]

[root]
id = "main"
name = "Main Root"
cwd = "${input.rootCwd.replaceAll("\\", "\\\\")}"
repoRoot = "${input.rootCwd.replaceAll("\\", "\\\\")}"
branchPolicy = "reuse"
permissionMode = "workspace-write"
envAllowlist = ["PATH"]
idleTtlHours = 24
`;
}
