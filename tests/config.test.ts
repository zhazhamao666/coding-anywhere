import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-config-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("parses feishu credentials, allowlist, and a single bridge root from the codex config section", () => {
    const configPath = path.join(rootDir, "config.toml");

    writeFileSync(
      configPath,
      `
[server]
port = 3000
host = "127.0.0.1"

[storage]
sqlitePath = "data/bridge.db"
logDir = "logs"

[codex]
command = "codex"

[feishu]
appId = "cli_xxx"
appSecret = "secret"
websocketUrl = "wss://example.invalid/ws"
apiBaseUrl = "https://open.feishu.cn/open-apis"
allowlist = ["ou_demo"]

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

    const config = loadConfig(configPath);

    expect(config.feishu.allowlist).toEqual(["ou_demo"]);
    expect(config.feishu.websocketUrl).toBe("wss://example.invalid/ws");
    expect(config.feishu.reconnectCount).toBe(-1);
    expect(config.feishu.reconnectIntervalSeconds).toBe(120);
    expect(config.feishu.reconnectNonceSeconds).toBe(30);
    expect(config.root.id).toBe("main");
    expect(config.root.cwd).toBe("D:/repos");
    expect((config as any).codex.command).toBe("codex");
  });

  it("accepts the legacy acpx config section as a compatibility alias for codex", () => {
    const configPath = path.join(rootDir, "config.toml");

    writeFileSync(
      configPath,
      `
[server]
port = 3000
host = "127.0.0.1"

[storage]
sqlitePath = "data/bridge.db"
logDir = "logs"

[acpx]
command = "acpx"
agent = "codex"

[feishu]
appId = "cli_xxx"
appSecret = "secret"
websocketUrl = "wss://example.invalid/ws"
apiBaseUrl = "https://open.feishu.cn/open-apis"
allowlist = ["ou_demo"]

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

    const config = loadConfig(configPath);

    expect((config as any).codex.command).toBe("codex");
  });

  it("parses explicit feishu websocket reconnect settings", () => {
    const configPath = path.join(rootDir, "config.toml");

    writeFileSync(
      configPath,
      `
[server]
port = 3000
host = "127.0.0.1"

[storage]
sqlitePath = "data/bridge.db"
logDir = "logs"

[codex]
command = "codex"

[feishu]
appId = "cli_xxx"
appSecret = "secret"
websocketUrl = "wss://example.invalid/ws"
apiBaseUrl = "https://open.feishu.cn/open-apis"
allowlist = ["ou_demo"]
reconnectCount = -1
reconnectIntervalSeconds = 45
reconnectNonceSeconds = 5

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

    const config = loadConfig(configPath);

    expect(config.feishu.reconnectCount).toBe(-1);
    expect(config.feishu.reconnectIntervalSeconds).toBe(45);
    expect(config.feishu.reconnectNonceSeconds).toBe(5);
  });
});
