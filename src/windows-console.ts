import { execFileSync as nodeExecFileSync } from "node:child_process";

interface WritableWithEncoding {
  setDefaultEncoding?: (encoding: BufferEncoding) => void;
}

interface EnsureWindowsConsoleUtf8Options {
  platform?: NodeJS.Platform;
  comspec?: string;
  execFileSync?: typeof nodeExecFileSync;
  stdout?: WritableWithEncoding;
  stderr?: WritableWithEncoding;
}

export function ensureWindowsConsoleUtf8(
  options: EnsureWindowsConsoleUtf8Options = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }

  options.stdout?.setDefaultEncoding?.("utf8");
  options.stderr?.setDefaultEncoding?.("utf8");

  const execFileSync = options.execFileSync ?? nodeExecFileSync;
  const comspec = options.comspec ?? process.env.ComSpec ?? "cmd.exe";

  try {
    execFileSync(comspec, ["/d", "/c", "chcp 65001>nul"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
