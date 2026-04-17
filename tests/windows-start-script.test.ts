import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const testsDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(testsDir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Windows runtime launch scripts", () => {
  it("protects the current wrapper process chain during start cleanup", () => {
    const content = readRepoFile("scripts/start.mjs");

    expect(content).toMatch(/listProtectedWindowsPids/);
    expect(content).toMatch(/cleanupBeforeStartup\(\{\s*protectedPids,/s);
  });

  it("protects the current wrapper process chain during dev cleanup", () => {
    const content = readRepoFile("scripts/dev.mjs");

    expect(content).toMatch(/listProtectedWindowsPids/);
    expect(content).toMatch(/cleanupBeforeStartup\(\{\s*protectedPids,/s);
  });
});
