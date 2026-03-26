import { accessSync, constants } from "node:fs";
import path from "node:path";

export function resolveExecutable(
  command: string,
  options?: {
    cwd?: string;
    pathValue?: string;
    isWindows?: boolean;
  },
): string | undefined {
  const cwd = options?.cwd ?? process.cwd();
  const pathValue = options?.pathValue ?? process.env.PATH ?? "";
  const isWindows = options?.isWindows ?? process.platform === "win32";

  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return fileExists(command) ? command : undefined;
  }

  const localBin = path.join(cwd, "node_modules", ".bin");
  const candidates = [
    ...buildCandidates(pathValue.split(path.delimiter).filter(Boolean), command, isWindows),
    ...buildCandidates([localBin], command, isWindows),
  ];

  return candidates.find(fileExists);
}

function buildCandidates(paths: string[], command: string, isWindows: boolean): string[] {
  const suffixes = isWindows ? [".cmd", ".exe", ".ps1", ""] : [""];
  const results: string[] = [];
  for (const base of paths) {
    for (const suffix of suffixes) {
      results.push(path.join(base, `${command}${suffix}`));
    }
  }
  return results;
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
