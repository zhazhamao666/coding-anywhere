import { describe, expect, it, vi } from "vitest";

import { ensureWindowsConsoleUtf8 } from "../src/windows-console.js";

describe("ensureWindowsConsoleUtf8", () => {
  it("switches the Windows console code page to UTF-8 and updates stream defaults", () => {
    const execFileSync = vi.fn();
    const stdout = {
      setDefaultEncoding: vi.fn(),
    };
    const stderr = {
      setDefaultEncoding: vi.fn(),
    };

    const changed = ensureWindowsConsoleUtf8({
      platform: "win32",
      comspec: "C:/Windows/System32/cmd.exe",
      execFileSync,
      stdout,
      stderr,
    });

    expect(changed).toBe(true);
    expect(stdout.setDefaultEncoding).toHaveBeenCalledWith("utf8");
    expect(stderr.setDefaultEncoding).toHaveBeenCalledWith("utf8");
    expect(execFileSync).toHaveBeenCalledWith(
      "C:/Windows/System32/cmd.exe",
      ["/d", "/c", "chcp 65001>nul"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
  });

  it("does nothing outside Windows", () => {
    const execFileSync = vi.fn();

    const changed = ensureWindowsConsoleUtf8({
      platform: "linux",
      execFileSync,
    });

    expect(changed).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
