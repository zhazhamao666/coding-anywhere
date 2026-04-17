import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const testsDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(testsDir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Windows launcher scripts", () => {
  it("provides a root start launcher that builds before starting", () => {
    const startLauncherPath = path.join(repoRoot, "start-coding-anywhere.cmd");

    expect(existsSync(startLauncherPath)).toBe(true);

    const content = readRepoFile("start-coding-anywhere.cmd");
    expect(content).toMatch(/pushd "%~dp0"/i);
    expect(content).toMatch(/call npm run build/i);
    expect(content).toMatch(/call npm run start/i);
    expect(content.indexOf("call npm run build")).toBeLessThan(content.indexOf("call npm run start"));
  });

  it("provides a root stop launcher that delegates to npm run stop", () => {
    const stopLauncherPath = path.join(repoRoot, "stop-coding-anywhere.cmd");

    expect(existsSync(stopLauncherPath)).toBe(true);

    const content = readRepoFile("stop-coding-anywhere.cmd");
    expect(content).toMatch(/pushd "%~dp0"/i);
    expect(content).toMatch(/call npm run stop/i);
  });

  it("exposes a reusable npm stop entrypoint backed by the shared cleanup helper", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.stop).toBe("node scripts/stop.mjs");
    expect(existsSync(path.join(repoRoot, "scripts", "stop.mjs"))).toBe(true);

    const stopScript = readRepoFile("scripts/stop.mjs");
    expect(stopScript).toMatch(/from "\.\/startup-cleanup\.mjs"/);
    expect(stopScript).toMatch(/cleanupBeforeStartup\(/);
  });
});
