import { execFileSync } from "node:child_process";
import process from "node:process";

import { cleanupBeforeStartup, switchWindowsConsoleToUtf8 } from "./startup-cleanup.mjs";
import { listProtectedWindowsPids } from "./stop-support.mjs";

if (process.platform === "win32") {
  switchWindowsConsoleToUtf8();
}

const protectedPids =
  process.platform === "win32"
    ? listProtectedWindowsPids(process.pid, { execFileSync })
    : [process.pid];

const targetIds = cleanupBeforeStartup({
  protectedPids,
});

if (targetIds.length > 0) {
  console.log(`Stopped Coding Anywhere processes: ${targetIds.join(", ")}`);
} else {
  console.log("No matching Coding Anywhere processes were running.");
}
