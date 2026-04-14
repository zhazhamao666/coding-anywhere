import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveExecutable } from "../src/executable.js";

describe("resolveExecutable", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "bridge-exec-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("finds a local node_modules bin when PATH does not include the command", () => {
    const binDir = path.join(rootDir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const codexPath = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    writeFileSync(codexPath, "@echo off\r\n", "utf8");

    const resolved = resolveExecutable("codex", {
      cwd: rootDir,
      pathValue: "",
      isWindows: process.platform === "win32",
    });

    expect(resolved).toBe(codexPath);
  });
});
