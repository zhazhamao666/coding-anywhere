import { spawn } from "node:child_process";
import process from "node:process";

import { cleanupBeforeStartup, spawnAfterCleanup, switchWindowsConsoleToUtf8 } from "./startup-cleanup.mjs";
import { listProtectedWindowsPids } from "./stop-support.mjs";

const protectedPids =
  process.platform === "win32" ? listProtectedWindowsPids(process.pid) : [process.pid];

const child =
  process.platform === "win32"
    ? (() => {
        cleanupBeforeStartup({
          protectedPids,
        });
        switchWindowsConsoleToUtf8();
        return spawn(
          "node",
          ["./node_modules/tsx/dist/cli.mjs", "watch", "src/index.ts"],
          {
            cwd: process.cwd(),
            stdio: "inherit",
            windowsHide: false,
          },
        );
      })()
    : spawnAfterCleanup(
        process.execPath,
        ["./node_modules/tsx/dist/cli.mjs", "watch", "src/index.ts"],
        {
          cwd: process.cwd(),
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
