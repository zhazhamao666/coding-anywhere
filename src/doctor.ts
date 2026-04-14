import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfigWithMetadata } from "./config.js";
import { resolveExecutable } from "./executable.js";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  severity: "blocking" | "warning";
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export function inspectEnvironment(input?: {
  cwd?: string;
  configPath?: string;
  codexHomePath?: string;
  resolveCommand?: (command: string) => string | undefined;
}): DoctorReport {
  const cwd = input?.cwd ?? process.cwd();
  const configPath = input?.configPath ?? path.join(cwd, "config.toml");
  const codexHomePath = input?.codexHomePath ?? resolveCodexHomePath();
  const resolveCommand =
    input?.resolveCommand ?? ((command: string) => resolveExecutable(command, { cwd }));

  const checks: DoctorCheck[] = [];

  checks.push({
    id: "codex",
    ok: Boolean(resolveCommand("codex")),
    severity: "blocking",
    message: "Codex CLI must be installed and discoverable.",
  });

  if (!existsSync(configPath)) {
    checks.push({
      id: "config",
      ok: false,
      severity: "blocking",
      message: `Missing config.toml at ${configPath}. Copy config.example.toml first.`,
    });

    return {
      ok: false,
      checks,
    };
  }

  const loaded = loadConfigWithMetadata(configPath);
  const config = loaded.config;

  if (loaded.usedLegacyAcpxSection) {
    checks.push({
      id: "config.legacyAcpxSection",
      ok: false,
      severity: "warning",
      message: "Legacy [acpx] config detected. Rename it to [codex] when convenient.",
    });
  }

  checks.push({
    id: "feishu.appId",
    ok: config.feishu.appId !== "cli_xxx",
    severity: "blocking",
    message: "Replace feishu.appId with the real App ID from Feishu Open Platform.",
  });
  checks.push({
    id: "feishu.appSecret",
    ok: config.feishu.appSecret !== "replace-me",
    severity: "blocking",
    message: "Replace feishu.appSecret with the real App Secret from Feishu Open Platform.",
  });
  checks.push({
    id: "feishu.allowlist",
    ok: !config.feishu.allowlist.includes("ou_xxx"),
    severity: "blocking",
    message: "Replace the placeholder open_id in feishu.allowlist.",
  });

  checks.push({
    id: "root.cwd",
    ok: existsSync(config.root.cwd),
    severity: "blocking",
    message: `CA root cwd must exist: ${config.root.cwd}`,
  });

  checks.push({
    id: "codex.realSmokeAuth",
    ok: existsSync(path.join(codexHomePath, "auth.json")),
    severity: "warning",
    message:
      "Real Codex smoke tests require an authenticated ~/.codex/auth.json (or equivalent codex home).",
  });

  checks.push({
    id: "codex.realSmokeOptIn",
    ok: false,
    severity: "warning",
    message:
      "Real Codex smoke tests are opt-in and cost-bearing. Use TEST_CODEX_REAL=1 (and TEST_CODEX_RESUME=1 for resume) only when intentionally spending real Codex calls.",
  });

  return {
    ok: checks.every(check => check.ok || check.severity !== "blocking"),
    checks,
  };
}

function resolveCodexHomePath(): string {
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
  return path.join(userHome, ".codex");
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map(check => {
    const marker = check.ok ? "[ok]" : check.severity === "blocking" ? "[block]" : "[warn]";
    return `${marker} ${check.id} ${check.message}`;
  });

  return lines.join("\n");
}
