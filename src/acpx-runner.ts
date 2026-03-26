import { execa } from "execa";

import type { AcpxEvent, RunContext, RunOutcome } from "./types.js";

export function parseAcpxEventLine(line: string): AcpxEvent | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof parsed.type === "string") {
    switch (parsed.type) {
      case "tool_call":
        return {
          type: "tool_call",
          toolName: parsed.tool_name ?? "unknown",
          content: parsed.content ?? "",
        };
      case "text":
        return {
          type: "text",
          content: parsed.content ?? "",
        };
      case "done":
        return {
          type: "done",
          content: parsed.content,
        };
      case "error":
        return {
          type: "error",
          content: parsed.content ?? "unknown error",
        };
      default:
        return {
          type: "waiting",
          content: parsed.content,
        };
    }
  }

  if (parsed?.error?.message) {
    return {
      type: "error",
      content: parsed.error.message,
    };
  }

  if (parsed?.method === "session/update") {
    const update = parsed?.params?.update;
    switch (update?.sessionUpdate) {
      case "agent_message_chunk": {
        const text =
          update?.content?.type === "text" ? update.content.text : undefined;
        if (!text) {
          return undefined;
        }
        return {
          type: "text",
          content: text,
        };
      }
      case "tool_call": {
        const title = update?.title ?? update?.rawInput?.title ?? "unknown";
        return {
          type: "tool_call",
          toolName: title,
          content: title,
        };
      }
      case "tool_call_update": {
        if (update?.status !== "failed") {
          return undefined;
        }

        return {
          type: "error",
          content:
            update?.rawOutput?.formatted_output ??
            update?.rawOutput?.stderr ??
            "tool call failed",
        };
      }
      default:
        return undefined;
    }
  }

  if (parsed?.result?.stopReason) {
    return {
      type: "done",
      content: undefined,
    };
  }

  return undefined;
}

export function coalesceAcpxEvent(event: AcpxEvent, assistantText: string): {
  event: AcpxEvent;
  assistantText: string;
} {
  switch (event.type) {
    case "text": {
      const nextAssistantText = `${assistantText}${event.content}`;
      return {
        assistantText: nextAssistantText,
        event: {
          ...event,
          content: nextAssistantText,
        },
      };
    }
    case "done":
      return {
        assistantText,
        event: {
          ...event,
          content: event.content ?? (assistantText || undefined),
        },
      };
    default:
      return {
        assistantText,
        event,
      };
  }
}

export class AcpxRunner {
  public constructor(
    private readonly command = "acpx",
    private readonly agent = "codex",
    private readonly codexCommand = "codex",
  ) {}

  public async checkHealth(): Promise<boolean> {
    const result = await execa(this.command, ["--version"], {
      reject: false,
    });

    return result.exitCode === 0;
  }

  public async ensureSession(context: RunContext): Promise<void> {
    if (context.targetKind === "codex_thread") {
      return;
    }

    const result = await execa(
      this.command,
      [this.agent, "sessions", "ensure", "--name", context.sessionName],
      {
        cwd: context.cwd,
        reject: false,
      },
    );

    if (result.exitCode !== 0) {
      throw new Error("SESSION_INIT_FAILED");
    }
  }

  public async cancel(context: RunContext): Promise<void> {
    if (context.targetKind === "codex_thread") {
      return;
    }

    const result = await execa(
      this.command,
      [this.agent, "cancel", "--session", context.sessionName],
      {
        cwd: context.cwd,
        reject: false,
      },
    );

    if (result.exitCode !== 0) {
      throw new Error("RUN_STREAM_FAILED");
    }
  }

  public async close(context: RunContext): Promise<void> {
    if (context.targetKind === "codex_thread") {
      return;
    }

    const result = await execa(
      this.command,
      [this.agent, "sessions", "close", context.sessionName],
      {
        cwd: context.cwd,
        reject: false,
      },
    );

    if (result.exitCode !== 0) {
      throw new Error("RUN_STREAM_FAILED");
    }
  }

  public async submitVerbatim(
    context: RunContext,
    prompt: string,
    onEvent?: (event: AcpxEvent) => void,
  ): Promise<RunOutcome> {
    if (context.targetKind === "codex_thread") {
      return this.submitToCodexThread(context, prompt, onEvent);
    }

    const child = execa(
      this.command,
      [
        "--format",
        "json",
        "--json-strict",
        this.agent,
        "prompt",
        "--session",
        context.sessionName,
        "--file",
        "-",
      ],
      {
        cwd: context.cwd,
        input: prompt,
        reject: false,
      },
    );

    const events: AcpxEvent[] = [];
    let buffer = "";
    let assistantText = "";

    if (child.stdout) {
      for await (const chunk of child.stdout) {
        buffer += chunk.toString();
        const { remainingBuffer, nextAssistantText } = await flushAcpxBuffer({
          buffer,
          assistantText,
          events,
          onEvent,
        });
        buffer = remainingBuffer;
        assistantText = nextAssistantText;
      }
    }

    const finalFlush = await flushAcpxBuffer({
      buffer,
      assistantText,
      events,
      onEvent,
      flushPartial: true,
    });
    assistantText = finalFlush.nextAssistantText;

    const result = await child;
    if (result.exitCode !== 0 && !events.some(event => event.type === "error")) {
      throw new Error("RUN_STREAM_FAILED");
    }

    return {
      events,
      exitCode: result.exitCode ?? 1,
    };
  }

  private async submitToCodexThread(
    context: Extract<RunContext, { targetKind: "codex_thread" }>,
    prompt: string,
    onEvent?: (event: AcpxEvent) => void,
  ): Promise<RunOutcome> {
    const child = execa(
      this.codexCommand,
      [
        "exec",
        "resume",
        "--json",
        context.threadId,
        "-",
      ],
      {
        cwd: context.cwd,
        input: prompt,
        reject: false,
      },
    );

    const events: AcpxEvent[] = [];
    let buffer = "";
    let assistantText = "";

    if (child.stdout) {
      for await (const chunk of child.stdout) {
        buffer += chunk.toString();
        const flushed = await flushCodexExecBuffer({
          buffer,
          assistantText,
          events,
          onEvent,
        });
        buffer = flushed.remainingBuffer;
        assistantText = flushed.nextAssistantText;
      }
    }

    const finalFlush = await flushCodexExecBuffer({
      buffer,
      assistantText,
      events,
      onEvent,
      flushPartial: true,
    });
    assistantText = finalFlush.nextAssistantText;

    const result = await child;
    if (result.exitCode !== 0 && !events.some(event => event.type === "error")) {
      throw new Error("RUN_STREAM_FAILED");
    }

    return {
      events,
      exitCode: result.exitCode ?? 1,
    };
  }
}

async function flushAcpxBuffer(input: {
  buffer: string;
  assistantText: string;
  events: AcpxEvent[];
  onEvent?: (event: AcpxEvent) => void;
  flushPartial?: boolean;
}): Promise<{ remainingBuffer: string; nextAssistantText: string }> {
  let remainingBuffer = input.buffer;
  let nextAssistantText = input.assistantText;

  while (true) {
    const newlineIndex = remainingBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = remainingBuffer.slice(0, newlineIndex).trim();
    remainingBuffer = remainingBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }

    const parsedEvent = parseAcpxEventLine(line);
    if (!parsedEvent) {
      continue;
    }

    const coalesced = coalesceAcpxEvent(parsedEvent, nextAssistantText);
    nextAssistantText = coalesced.assistantText;
    input.events.push(coalesced.event);
    await onAcpxEvent(input.onEvent, coalesced.event);
  }

  if (input.flushPartial) {
    const tail = remainingBuffer.trim();
    if (tail) {
      const parsedEvent = parseAcpxEventLine(tail);
      if (parsedEvent) {
        const coalesced = coalesceAcpxEvent(parsedEvent, nextAssistantText);
        nextAssistantText = coalesced.assistantText;
        input.events.push(coalesced.event);
        await onAcpxEvent(input.onEvent, coalesced.event);
      }
      remainingBuffer = "";
    }
  }

  return {
    remainingBuffer,
    nextAssistantText,
  };
}

async function flushCodexExecBuffer(input: {
  buffer: string;
  assistantText: string;
  events: AcpxEvent[];
  onEvent?: (event: AcpxEvent) => void;
  flushPartial?: boolean;
}): Promise<{ remainingBuffer: string; nextAssistantText: string }> {
  let remainingBuffer = input.buffer;
  let nextAssistantText = input.assistantText;

  while (true) {
    const newlineIndex = remainingBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = remainingBuffer.slice(0, newlineIndex).trim();
    remainingBuffer = remainingBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }

    const parsedEvent = parseCodexExecEventLine(line);
    if (!parsedEvent) {
      continue;
    }

    const coalesced = coalesceAcpxEvent(parsedEvent, nextAssistantText);
    nextAssistantText = coalesced.assistantText;
    input.events.push(coalesced.event);
    await onAcpxEvent(input.onEvent, coalesced.event);
  }

  if (input.flushPartial) {
    const tail = remainingBuffer.trim();
    if (tail) {
      const parsedEvent = parseCodexExecEventLine(tail);
      if (parsedEvent) {
        const coalesced = coalesceAcpxEvent(parsedEvent, nextAssistantText);
        nextAssistantText = coalesced.assistantText;
        input.events.push(coalesced.event);
        await onAcpxEvent(input.onEvent, coalesced.event);
      }
      remainingBuffer = "";
    }
  }

  return {
    remainingBuffer,
    nextAssistantText,
  };
}

function parseCodexExecEventLine(line: string): AcpxEvent | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  switch (parsed?.type) {
    case "item.started":
      if (parsed?.item?.type === "command_execution") {
        return {
          type: "tool_call",
          toolName: parsed.item.command ?? "command_execution",
          content: parsed.item.command ?? "command_execution",
        };
      }
      return undefined;
    case "item.completed":
      if (parsed?.item?.type === "agent_message") {
        return {
          type: "text",
          content: parsed.item.text ?? "",
        };
      }
      if (parsed?.item?.type === "command_execution" && parsed?.item?.exit_code && parsed.item.exit_code !== 0) {
        return {
          type: "error",
          content: parsed.item.aggregated_output ?? "command_execution failed",
        };
      }
      return undefined;
    case "turn.completed":
      return {
        type: "done",
        content: undefined,
      };
    default:
      return undefined;
  }
}

async function onAcpxEvent(
  onEvent: ((event: AcpxEvent) => void | Promise<void>) | undefined,
  event: AcpxEvent,
) {
  if (!onEvent) {
    return;
  }

  await onEvent(event);
}
