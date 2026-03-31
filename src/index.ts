import path from "node:path";

import pino from "pino";

import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { createTimestampPrefixingConsoleStream } from "./timestamped-console-stream.js";
import { ensureWindowsConsoleUtf8 } from "./windows-console.js";

ensureWindowsConsoleUtf8();

const logger = pino({
  name: "coding-anywhere",
  timestamp: false,
}, createTimestampPrefixingConsoleStream(process.stdout));

async function main() {
  const configPath = process.env.BRIDGE_CONFIG ?? path.resolve(process.cwd(), "config.toml");
  const config = loadConfig(configPath);
  const runtime = await createRuntime(config, { logger });

  await runtime.start();
  logger.info({ host: config.server.host, port: config.server.port }, "coding anywhere runtime started");
}

main().catch(error => {
  logger.error({ error }, "coding anywhere server failed");
  process.exitCode = 1;
});
