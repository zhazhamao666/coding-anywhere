import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";

import { ensureWindowsConsoleUtf8 } from "./windows-console.js";

ensureWindowsConsoleUtf8();

const cwd = process.cwd();
const source = path.join(cwd, "config.example.toml");
const target = path.join(cwd, "config.toml");

if (existsSync(target)) {
  console.log(`[ca] config already exists: ${target}`);
} else {
  copyFileSync(source, target);
  console.log(`[ca] config created from example: ${target}`);
}
