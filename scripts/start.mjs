import { spawn } from "node:child_process";
import process from "node:process";

import { cleanupBeforeStartup, switchWindowsConsoleToUtf8 } from "./startup-cleanup.mjs";
import { listProtectedWindowsPids } from "./stop-support.mjs";

const entrypoint = "dist/src/index.js";
const protectedPids =
  process.platform === "win32" ? listProtectedWindowsPids(process.pid) : [process.pid];

cleanupBeforeStartup({
  protectedPids,
});

if (process.platform === "win32") {
  switchWindowsConsoleToUtf8();
  const child = spawn(
    "node",
    [entrypoint],
    {
      stdio: "inherit",
      windowsHide: false,
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  child.on("exit", code => {
    process.exit(code ?? 0);
  });

  child.on("error", error => {
    console.error(error);
    process.exit(1);
  });
} else {
  const child = spawn(process.execPath, [entrypoint], {
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  child.on("exit", code => {
    process.exit(code ?? 0);
  });

  child.on("error", error => {
    console.error(error);
    process.exit(1);
  });
}
