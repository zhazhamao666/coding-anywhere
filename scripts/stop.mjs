import { execFileSync } from "node:child_process";
import process from "node:process";

import { cleanupBeforeStartup, switchWindowsConsoleToUtf8 } from "./startup-cleanup.mjs";
import { buildWindowsProtectedPidQuery, parseProtectedWindowsPids } from "./stop-support.mjs";

function listProtectedWindowsPids(currentPid) {
  try {
    const rawOutput = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", buildWindowsProtectedPidQuery(currentPid)],
      { encoding: "utf8" },
    ).trim();

    return parseProtectedWindowsPids(rawOutput, currentPid);
  } catch {
    return [currentPid];
  }
}

if (process.platform === "win32") {
  switchWindowsConsoleToUtf8();
}

const protectedPids =
  process.platform === "win32" ? listProtectedWindowsPids(process.pid) : [process.pid];

const targetIds = cleanupBeforeStartup({
  protectedPids,
});

if (targetIds.length > 0) {
  console.log(`Stopped Coding Anywhere processes: ${targetIds.join(", ")}`);
} else {
  console.log("No matching Coding Anywhere processes were running.");
}
