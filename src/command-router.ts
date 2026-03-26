import type { BridgeCommand, BridgeInput } from "./types.js";

export const BRIDGE_COMMAND_PREFIX = "/ca";

export function routeBridgeInput(message: string): BridgeInput {
  if (!message.startsWith(BRIDGE_COMMAND_PREFIX)) {
    return {
      kind: "prompt",
      prompt: message,
    };
  }

  const tokens = message.trim().split(/\s+/).slice(1);
  const [head = "hub", ...rest] = tokens;

  return {
    kind: "command",
    command: {
      name: normalizeCommand(head),
      args: rest,
    },
  };
}

export function isBridgeCommandMessage(message: string): boolean {
  return message.startsWith(BRIDGE_COMMAND_PREFIX);
}

function normalizeCommand(raw: string): BridgeCommand["name"] {
  switch (raw) {
    case "status":
    case "hub":
    case "new":
    case "stop":
    case "session":
    case "logs":
    case "project":
    case "thread":
    case "help":
      return raw;
    default:
      return "help";
  }
}
