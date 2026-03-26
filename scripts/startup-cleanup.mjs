import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import toml from "toml";

function normalizePath(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function toArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function parseJsonOutput(raw) {
  const text = raw.trim();
  if (!text) {
    return [];
  }

  return toArray(JSON.parse(text));
}

function quoteCmdArg(value) {
  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '\\"')}"`;
}

export function switchWindowsConsoleToUtf8(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }

  const execFile = options.execFileSync ?? execFileSync;
  const comspec = options.comspec ?? process.env.ComSpec ?? "cmd.exe";
  execFile(comspec, ["/d", "/c", "chcp 65001>nul"], {
    stdio: "inherit",
    windowsHide: false,
  });
  return true;
}

function loadConfiguredPort(cwd) {
  const configPath = path.join(cwd, "config.toml");
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const parsed = toml.parse(readFileSync(configPath, "utf8"));
    return typeof parsed?.server?.port === "number" ? parsed.server.port : undefined;
  } catch {
    return undefined;
  }
}

function listWindowsProcesses() {
  const command =
    "Get-CimInstance Win32_Process | " +
    "Where-Object { $_.Name -match '^(node|npm|cmd)\\.exe$' } | " +
    "Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" },
  );
  return parseJsonOutput(output);
}

export function buildWindowsListenerQuery(port) {
  return (
    `@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ` +
    "Select-Object OwningProcess, LocalPort) | ConvertTo-Json -Compress"
  );
}

export function buildWindowsNodeLaunchCommand(nodeExecutable, scriptPath, scriptArgs = []) {
  const commandParts = [
    nodeExecutable,
    scriptPath,
    ...scriptArgs.map(argument => quoteCmdArg(argument)),
  ];
  return `chcp 65001>nul && ${commandParts.join(" ")}`;
}

function listWindowsListeners(port) {
  const command = buildWindowsListenerQuery(port);
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" },
  );
  return parseJsonOutput(output);
}

export function collectCleanupTargets({
  cwd,
  port,
  currentPid,
  processes,
  listeners,
}) {
  const normalizedCwd = normalizePath(cwd);
  const targetIds = new Set();

  for (const processInfo of processes) {
    const pid = Number(processInfo?.ProcessId);
    const commandLine =
      typeof processInfo?.CommandLine === "string" ? processInfo.CommandLine : "";
    if (!pid || pid === currentPid) {
      continue;
    }

    if (normalizePath(commandLine).includes(normalizedCwd)) {
      targetIds.add(pid);
    }
  }

  for (const listener of listeners) {
    const pid = Number(listener?.OwningProcess);
    const listenerPort = Number(listener?.LocalPort);
    if (!pid || pid === currentPid || listenerPort !== port) {
      continue;
    }

    targetIds.add(pid);
  }

  return [...targetIds].sort((left, right) => left - right);
}

export function cleanupBeforeStartup(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const currentPid = options.currentPid ?? process.pid;
  const port = options.port ?? loadConfiguredPort(cwd);

  if (platform !== "win32" || !port) {
    return [];
  }

  const processes = options.processes ?? listWindowsProcesses();
  const listeners = options.listeners ?? listWindowsListeners(port);
  const targetIds = collectCleanupTargets({
    cwd,
    port,
    currentPid,
    processes,
    listeners,
  });

  for (const pid of targetIds) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/F", "/T"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Best-effort cleanup. A process may already have exited.
    }
  }

  return targetIds;
}

export function spawnAfterCleanup(command, args, options = {}) {
  cleanupBeforeStartup({
    cwd: options.cwd,
    port: options.port,
  });

  return spawn(command, args, options);
}
