import path from "node:path";

import { formatDoctorReport, inspectEnvironment } from "./doctor.js";
import { ensureWindowsConsoleUtf8 } from "./windows-console.js";

ensureWindowsConsoleUtf8();

const configPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(process.cwd(), "config.toml");

const report = inspectEnvironment({
  cwd: process.cwd(),
  configPath,
});

console.log(formatDoctorReport(report));

if (!report.ok) {
  process.exitCode = 1;
}
