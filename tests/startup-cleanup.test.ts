import { describe, expect, it, vi } from "vitest";

// Vitest can execute the ESM helper directly; TypeScript just lacks a local declaration here.
// @ts-ignore
import { buildWindowsListenerQuery, buildWindowsNodeLaunchCommand, collectCleanupTargets, switchWindowsConsoleToUtf8 } from "../scripts/startup-cleanup.mjs";

describe("collectCleanupTargets", () => {
  it("switches the active Windows console to UTF-8 before startup", () => {
    const execFileSync = vi.fn();

    const changed = switchWindowsConsoleToUtf8({
      platform: "win32",
      comspec: "C:/Windows/System32/cmd.exe",
      execFileSync,
    });

    expect(changed).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      "C:/Windows/System32/cmd.exe",
      ["/d", "/c", "chcp 65001>nul"],
      {
        stdio: "inherit",
        windowsHide: false,
      },
    );
  });

  it("builds a Windows cmd launch command that switches the console to UTF-8 first", () => {
    expect(
      buildWindowsNodeLaunchCommand("node", "./node_modules/tsx/dist/cli.mjs", ["watch", "src/index.ts"]),
    ).toBe(
      "chcp 65001>nul && node ./node_modules/tsx/dist/cli.mjs watch src/index.ts",
    );
  });

  it("wraps the port listener query so an empty result still exits successfully", () => {
    expect(buildWindowsListenerQuery(3100)).toBe(
      "@(Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue | Select-Object OwningProcess, LocalPort) | ConvertTo-Json -Compress",
    );
  });

  it("collects project-owned node processes and the configured listening port", () => {
    const targets = collectCleanupTargets({
      cwd: "D:/eijud/OneDrive/eijud-sync/project/coding-anywhere",
      port: 3100,
      currentPid: 9000,
      processes: [
        {
          ProcessId: 1234,
          Name: "node.exe",
          CommandLine: "\"node\" \"D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/node_modules/tsx/dist/cli.mjs\" watch src/index.ts",
        },
        {
          ProcessId: 2234,
          Name: "cmd.exe",
          CommandLine: "cmd.exe /d /c cd /d D:/eijud/OneDrive/eijud-sync/project/coding-anywhere && npm run start",
        },
        {
          ProcessId: 3234,
          Name: "node.exe",
          CommandLine: "node dist/src/index.js",
        },
        {
          ProcessId: 4234,
          Name: "node.exe",
          CommandLine: "\"node\" \"D:/other-project/node_modules/tsx/dist/cli.mjs\" watch src/index.ts",
        },
      ],
      listeners: [
        {
          OwningProcess: 3234,
          LocalPort: 3100,
        },
      ],
    });

    expect(targets).toEqual([1234, 2234, 3234]);
  });

  it("skips the current process and non-matching listeners", () => {
    const targets = collectCleanupTargets({
      cwd: "D:/eijud/OneDrive/eijud-sync/project/coding-anywhere",
      port: 3100,
      currentPid: 1234,
      processes: [
        {
          ProcessId: 1234,
          Name: "node.exe",
          CommandLine: "\"node\" \"D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/node_modules/tsx/dist/cli.mjs\" watch src/index.ts",
        },
      ],
      listeners: [
        {
          OwningProcess: 5555,
          LocalPort: 3200,
        },
      ],
    });

    expect(targets).toEqual([]);
  });

  it("skips explicitly protected process ids so the stop command does not kill its own wrapper", () => {
    const targets = collectCleanupTargets({
      cwd: "D:/eijud/OneDrive/eijud-sync/project/coding-anywhere",
      port: 3100,
      currentPid: 9000,
      protectedPids: [2234, 3234],
      processes: [
        {
          ProcessId: 1234,
          Name: "node.exe",
          CommandLine: "\"node\" \"D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/dist/src/index.js\"",
        },
        {
          ProcessId: 2234,
          Name: "cmd.exe",
          CommandLine: "cmd.exe /d /s /c cd /d D:/eijud/OneDrive/eijud-sync/project/coding-anywhere && node scripts/stop.mjs",
        },
        {
          ProcessId: 3234,
          Name: "node.exe",
          CommandLine: "\"node\" \"C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js\" --prefix D:/eijud/OneDrive/eijud-sync/project/coding-anywhere run stop",
        },
      ],
      listeners: [
        {
          OwningProcess: 1234,
          LocalPort: 3100,
        },
      ],
    });

    expect(targets).toEqual([1234]);
  });
});
