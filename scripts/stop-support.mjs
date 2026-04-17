import { execFileSync } from "node:child_process";

export function buildWindowsProtectedPidQuery(currentPid) {
  return (
    "$protected = New-Object System.Collections.Generic.List[int]; " +
    `$currentPidValue = ${currentPid}; ` +
    "$probePid = $currentPidValue; " +
    "while ($probePid -gt 0) { " +
    "  $protected.Add($probePid); " +
    '  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $probePid" -ErrorAction SilentlyContinue; ' +
    "  if (-not $process) { break; } " +
    "  $parentPid = [int]$process.ParentProcessId; " +
    "  if ($parentPid -le 0 -or $parentPid -eq $probePid) { break; } " +
    "  $probePid = $parentPid; " +
    "} " +
    "$protected | Select-Object -Unique | ConvertTo-Json -Compress"
  );
}

export function parseProtectedWindowsPids(rawOutput, fallbackPid) {
  const normalized = typeof rawOutput === "string" ? rawOutput.trim() : "";
  if (!normalized) {
    return [fallbackPid];
  }

  try {
    const parsed = JSON.parse(normalized);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const protectedPids = values
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0);

    return protectedPids.length > 0 ? protectedPids : [fallbackPid];
  } catch {
    const numericValue = Number(normalized);
    return Number.isInteger(numericValue) && numericValue > 0 ? [numericValue] : [fallbackPid];
  }
}

export function listProtectedWindowsPids(currentPid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [currentPid];
  }

  const execFile = options.execFileSync ?? execFileSync;

  try {
    const rawOutput = execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", buildWindowsProtectedPidQuery(currentPid)],
      { encoding: "utf8" },
    ).trim();

    return parseProtectedWindowsPids(rawOutput, currentPid);
  } catch {
    return [currentPid];
  }
}
