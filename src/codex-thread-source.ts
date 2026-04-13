import type { CodexCatalogThreadSourceInfo } from "./types.js";

export function parseCodexThreadSourceInfo(source: string): CodexCatalogThreadSourceInfo {
  const trimmed = source.trim();
  if (!trimmed) {
    return {
      kind: "unknown",
      label: "未知",
    };
  }

  if (looksLikeJson(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      const threadSpawn = parsed?.subagent?.thread_spawn;
      if (threadSpawn && typeof threadSpawn === "object") {
        return {
          kind: "subagent",
          label: "子 agent",
          parentThreadId: typeof threadSpawn.parent_thread_id === "string"
            ? threadSpawn.parent_thread_id
            : undefined,
          depth: typeof threadSpawn.depth === "number" && Number.isFinite(threadSpawn.depth)
            ? threadSpawn.depth
            : undefined,
          agentNickname: typeof threadSpawn.agent_nickname === "string"
            ? threadSpawn.agent_nickname
            : undefined,
          agentRole: typeof threadSpawn.agent_role === "string"
            ? threadSpawn.agent_role
            : undefined,
        };
      }
    } catch {
      return {
        kind: "unknown",
        label: "Codex 元数据",
      };
    }

    return {
      kind: "unknown",
      label: "Codex 元数据",
    };
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "vscode") {
    return {
      kind: "normal",
      label: "VS Code",
    };
  }
  if (normalized === "cli") {
    return {
      kind: "normal",
      label: "CLI",
    };
  }
  if (normalized === "unknown") {
    return {
      kind: "unknown",
      label: "未知",
    };
  }

  return {
    kind: "normal",
    label: trimmed,
  };
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}
