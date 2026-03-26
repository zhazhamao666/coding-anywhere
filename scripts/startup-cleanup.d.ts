export interface CleanupProcessInfo {
  ProcessId?: number;
  Name?: string;
  CommandLine?: string;
}

export interface CleanupListenerInfo {
  OwningProcess?: number;
  LocalPort?: number;
}

export function collectCleanupTargets(options: {
  cwd: string;
  port: number;
  currentPid?: number;
  processes: CleanupProcessInfo[];
  listeners: CleanupListenerInfo[];
}): number[];

export function buildWindowsListenerQuery(port: number): string;

export function buildWindowsNodeLaunchCommand(
  nodeExecutable: string,
  scriptPath: string,
  scriptArgs?: string[],
): string;

export function switchWindowsConsoleToUtf8(options?: {
  platform?: NodeJS.Platform;
  comspec?: string;
  execFileSync?: typeof import("node:child_process").execFileSync;
}): boolean;

export function cleanupBeforeStartup(options?: {
  cwd?: string;
  port?: number;
  platform?: NodeJS.Platform;
  currentPid?: number;
  processes?: CleanupProcessInfo[];
  listeners?: CleanupListenerInfo[];
}): number[];

export function spawnAfterCleanup(
  command: string,
  args: string[],
  options?: import("node:child_process").SpawnOptions,
): import("node:child_process").ChildProcess;
