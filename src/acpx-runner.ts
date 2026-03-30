import { execa } from "execa";

import type {
  AcpxEvent,
  PlanChoiceOption,
  PlanInteractionDraft,
  PlanTodoItem,
  RunContext,
  RunOutcome,
} from "./types.js";

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
    void context;
  }

  public async cancel(context: RunContext): Promise<void> {
    void context;
  }

  public async close(context: RunContext): Promise<void> {
    void context;
  }

  public async createThread(
    input: {
      cwd: string;
      prompt: string;
    },
    onEvent?: (event: AcpxEvent) => void,
  ): Promise<RunOutcome & { threadId: string }> {
    const outcome = await this.runCodexExec(
      ["exec", "--json", "-"],
      input.cwd,
      input.prompt,
      onEvent,
    );

    if (!outcome.threadId) {
      throw new Error("CODEX_THREAD_ID_MISSING");
    }

    return {
      ...outcome,
      threadId: outcome.threadId,
    };
  }

  public async submitVerbatim(
    context: RunContext,
    prompt: string,
    onEvent?: (event: AcpxEvent) => void,
  ): Promise<RunOutcome> {
    if (context.targetKind === "codex_thread") {
      return this.runCodexExec(
        [
          "exec",
          "resume",
          "--json",
          context.threadId,
          "-",
        ],
        context.cwd,
        prompt,
        onEvent,
      );
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

  private async runCodexExec(
    args: string[],
    cwd: string,
    prompt: string,
    onEvent?: (event: AcpxEvent) => void,
  ): Promise<RunOutcome> {
    const child = execa(
      this.codexCommand,
      args,
      {
        cwd,
        input: prompt,
        reject: false,
      },
    );

    const events: AcpxEvent[] = [];
    let buffer = "";
    let assistantText = "";
    let threadId: string | undefined;

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
        threadId = threadId ?? flushed.threadId;
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
    threadId = threadId ?? finalFlush.threadId;

    const result = await child;
    if (result.exitCode !== 0 && !events.some(event => event.type === "error")) {
      throw new Error("RUN_STREAM_FAILED");
    }

    return {
      events,
      exitCode: result.exitCode ?? 1,
      threadId,
    };
  }
}

function coalesceCodexExecEvent(event: AcpxEvent, assistantText: string): {
  event: AcpxEvent;
  assistantText: string;
} {
  switch (event.type) {
    case "text":
      return {
        assistantText: event.content,
        event,
      };
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
}): Promise<{ remainingBuffer: string; nextAssistantText: string; threadId?: string }> {
  let remainingBuffer = input.buffer;
  let nextAssistantText = input.assistantText;
  let threadId: string | undefined;

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

    const parsed = parseCodexExecLine(line);
    if (!parsed) {
      continue;
    }

    threadId = threadId ?? parsed.threadId;
    if (parsed.event) {
      const coalesced = coalesceCodexExecEvent(parsed.event, nextAssistantText);
      nextAssistantText = coalesced.assistantText;
      input.events.push(coalesced.event);
      await onAcpxEvent(input.onEvent, coalesced.event);
    }
  }

  if (input.flushPartial) {
    const tail = remainingBuffer.trim();
    if (tail) {
      const parsed = parseCodexExecLine(tail);
      if (parsed) {
        threadId = threadId ?? parsed.threadId;
        if (parsed.event) {
          const coalesced = coalesceCodexExecEvent(parsed.event, nextAssistantText);
          nextAssistantText = coalesced.assistantText;
          input.events.push(coalesced.event);
          await onAcpxEvent(input.onEvent, coalesced.event);
        }
      }
      remainingBuffer = "";
    }
  }

  return {
    remainingBuffer,
    nextAssistantText,
    threadId,
  };
}

function parseCodexExecLine(line: string): { event?: AcpxEvent; threadId?: string } | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (parsed?.type === "thread.started" && typeof parsed?.thread_id === "string") {
    return {
      threadId: parsed.thread_id,
    };
  }

  switch (parsed?.type) {
    case "item.started":
      if (parsed?.item?.type === "command_execution") {
        return {
          event: {
            type: "tool_call",
            toolName: parsed.item.command ?? "command_execution",
            content: parsed.item.command ?? "command_execution",
          },
        };
      }
      if (parsed?.item?.type === "todo_list") {
        const todos = parseTodoItems(parsed.item.items);
        return {
          event: {
            type: "waiting",
            content: formatTodoList(parsed.item.items),
            planTodos: todos,
          },
        };
      }
      if (parsed?.item?.type === "collab_tool_call") {
        return {
          event: {
            type: "tool_call",
            toolName: parsed.item.tool ?? "collab_tool_call",
            content: parsed.item.tool ?? "collab_tool_call",
          },
        };
      }
      return undefined;
    case "item.completed":
      if (parsed?.item?.type === "agent_message") {
        const extracted = extractBridgePlanInteraction(parsed.item.text ?? "");
        return {
          event: {
            type: "text",
            content: extracted.content || extracted.planInteraction?.question || "",
            planInteraction: extracted.planInteraction,
          },
        };
      }
      if (parsed?.item?.type === "command_execution" && parsed?.item?.exit_code && parsed.item.exit_code !== 0) {
        return {
          event: {
            type: "error",
            content: parsed.item.aggregated_output ?? "command_execution failed",
          },
        };
      }
      return undefined;
    case "turn.completed":
      return {
        event: {
          type: "done",
          content: undefined,
        },
      };
    default:
      return undefined;
  }
}

function formatTodoList(items: any): string | undefined {
  const texts = parseTodoItems(items)
    .map(item => item.text)
    .filter(value => value.length > 0);

  return texts.length > 0 ? texts.join("; ") : undefined;
}

function parseTodoItems(items: unknown): PlanTodoItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map(item => ({
      text: typeof item?.text === "string" ? item.text : "",
      completed: item?.completed === true,
    }))
    .filter(item => item.text.length > 0);
}

function extractBridgePlanInteraction(text: string): {
  content: string;
  planInteraction?: PlanInteractionDraft;
} {
  const match = text.match(/\[bridge-plan-choice\]\s*([\s\S]*?)\s*\[\/bridge-plan-choice\]/);
  if (!match) {
    return {
      content: text,
    };
  }

  const rawJson = match[1]?.trim();
  if (!rawJson) {
    return {
      content: stripBridgeDirective(text),
    };
  }

  try {
    const parsed = JSON.parse(rawJson) as {
      question?: string;
      choices?: Array<{
        id?: string;
        choiceId?: string;
        label?: string;
        description?: string;
        answer?: string;
        responseText?: string;
      }>;
    };
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    const choices = Array.isArray(parsed.choices)
      ? parsed.choices
        .map(normalizePlanChoice)
        .filter((choice): choice is PlanChoiceOption => choice !== undefined)
      : [];

    return {
      content: stripBridgeDirective(text) || question,
      planInteraction: question && choices.length > 0
        ? {
            question,
            choices,
          }
        : undefined,
    };
  } catch {
    return {
      content: stripBridgeDirective(text),
    };
  }
}

function normalizePlanChoice(choice: {
  id?: string;
  choiceId?: string;
  label?: string;
  description?: string;
  answer?: string;
  responseText?: string;
}): PlanChoiceOption | undefined {
  const choiceId = typeof choice.choiceId === "string"
    ? choice.choiceId
    : typeof choice.id === "string"
      ? choice.id
      : undefined;
  const label = typeof choice.label === "string" ? choice.label.trim() : "";
  const responseText = typeof choice.responseText === "string"
    ? choice.responseText.trim()
    : typeof choice.answer === "string"
      ? choice.answer.trim()
      : "";

  if (!choiceId || !label || !responseText) {
    return undefined;
  }

  return {
    choiceId,
    label,
    responseText,
    description: typeof choice.description === "string" ? choice.description.trim() : undefined,
  };
}

function stripBridgeDirective(text: string): string {
  return text
    .replace(/\[bridge-plan-choice\]\s*[\s\S]*?\s*\[\/bridge-plan-choice\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
