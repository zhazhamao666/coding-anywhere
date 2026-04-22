import { execa } from "execa";

import { RunCanceledError } from "./run-cancel-error.js";
import type {
  CodexReasoningEffort,
  CodexSpeed,
  PlanChoiceOption,
  PlanInteractionDraft,
  PlanTodoItem,
  RunContext,
  RunOutcome,
  RunnerEvent,
} from "./types.js";

export class CodexCliRunner {
  private readonly activeExecutions = new Map<string, {
    cancelRequested: boolean;
    child: {
      kill?: (...args: any[]) => boolean;
    };
  }>();

  public constructor(
    private readonly codexCommand = "codex",
  ) {}

  public async checkHealth(): Promise<boolean> {
    const result = await execa(this.codexCommand, ["--version"], {
      reject: false,
    });

    return result.exitCode === 0;
  }

  public async ensureSession(context: RunContext): Promise<void> {
    void context;
  }

  public async cancel(context: RunContext): Promise<void> {
    const execution = this.activeExecutions.get(buildExecutionKey(context));
    if (execution) {
      execution.cancelRequested = true;
      execution.child.kill?.("SIGTERM", {
        forceKillAfterTimeout: false,
      });
    }
  }

  public async close(context: RunContext): Promise<void> {
    void context;
  }

  public async createThread(
    input: {
      cwd: string;
      prompt: string;
      images?: string[];
      sessionName?: string;
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
      speed?: CodexSpeed;
    },
    onEvent?: (event: RunnerEvent) => void,
  ): Promise<RunOutcome & { threadId: string }> {
    const args = withCodexPreferences(
      await this.resolveWorkspaceArgs(
        ["exec", "--json", "-"],
        input.cwd,
        1,
      ),
      {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        speed: input.speed,
      },
    );
    const outcome = await this.runCodexExec(
      withCodexImages(args, input.images),
      input.cwd,
      input.prompt,
      input.sessionName ? `session:${input.sessionName}` : undefined,
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
    optionsOrOnEvent?: {
      images?: string[];
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
      speed?: CodexSpeed;
    } | ((event: RunnerEvent) => void),
    onEvent?: (event: RunnerEvent) => void,
  ): Promise<RunOutcome> {
    const options = typeof optionsOrOnEvent === "function" ? undefined : optionsOrOnEvent;
    const effectiveOnEvent = typeof optionsOrOnEvent === "function" ? optionsOrOnEvent : onEvent;

    if (context.targetKind !== "codex_thread") {
      throw new Error("CODEX_THREAD_CONTEXT_REQUIRED");
    }

    const args = withCodexPreferences(
      await this.resolveWorkspaceArgs(
        [
          "exec",
          "resume",
          "--json",
          context.threadId,
          "-",
        ],
        context.cwd,
        2,
      ),
      {
        model: options?.model,
        reasoningEffort: options?.reasoningEffort,
        speed: options?.speed,
      },
    );

    return this.runCodexExec(
      withCodexImages(args, options?.images, 2),
      context.cwd,
      prompt,
      buildExecutionKey(context),
      effectiveOnEvent,
    );
  }

  private async runCodexExec(
    args: string[],
    cwd: string,
    prompt: string,
    executionKey: string | undefined,
    onEvent?: (event: RunnerEvent) => void,
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
    if (executionKey) {
      this.activeExecutions.set(executionKey, {
        cancelRequested: false,
        child,
      });
    }

    const events: RunnerEvent[] = [];
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
    threadId = threadId ?? finalFlush.threadId;

    try {
      const result = await child;
      const execution = executionKey ? this.activeExecutions.get(executionKey) : undefined;
      if (execution?.cancelRequested) {
        throw new RunCanceledError();
      }
      if (result.exitCode !== 0 && !events.some(event => event.type === "error")) {
        throw new Error(extractCodexExecFailure(result.stderr) ?? "RUN_STREAM_FAILED");
      }

      return {
        events,
        exitCode: result.exitCode ?? 1,
        threadId,
      };
    } finally {
      if (executionKey) {
        this.activeExecutions.delete(executionKey);
      }
    }
  }

  private async resolveWorkspaceArgs(
    args: string[],
    cwd: string,
    trailingArgsCount: number,
  ): Promise<string[]> {
    if (args.includes("--skip-git-repo-check")) {
      return args;
    }

    const result = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      reject: false,
    });

    if (result.exitCode === 0) {
      return args;
    }

    if (isNotGitRepositoryError(result.stderr)) {
      return insertArgsBeforeTrailing(args, ["--skip-git-repo-check"], trailingArgsCount);
    }

    throw new Error(extractCodexExecFailure(result.stderr) ?? "GIT_REPO_CHECK_FAILED");
  }
}

function buildExecutionKey(context: RunContext): string {
  if (context.targetKind === "codex_thread") {
    return `thread:${context.threadId}`;
  }

  return `session:${context.sessionName}`;
}

function withCodexImages(
  args: string[],
  images: string[] | undefined,
  trailingArgsCount = 1,
): string[] {
  if (!images || images.length === 0) {
    return args;
  }

  return insertArgsBeforeTrailing(
    args,
    images.flatMap(imagePath => ["-i", imagePath]),
    trailingArgsCount,
  );
}

function withCodexPreferences(
  args: string[],
  options: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    speed?: CodexSpeed;
  },
): string[] {
  const settingsArgs: string[] = [];
  if (options.model?.trim()) {
    settingsArgs.push("-m", options.model.trim());
  }
  if (options.reasoningEffort?.trim()) {
    settingsArgs.push("-c", `model_reasoning_effort="${options.reasoningEffort.trim()}"`);
  }
  if (options.speed === "fast") {
    settingsArgs.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  } else if (options.speed === "standard") {
    settingsArgs.push("-c", "features.fast_mode=false");
  }

  if (settingsArgs.length === 0) {
    return args;
  }

  const jsonFlagIndex = args.indexOf("--json");
  if (jsonFlagIndex >= 0) {
    return [
      ...args.slice(0, jsonFlagIndex),
      ...settingsArgs,
      ...args.slice(jsonFlagIndex),
    ];
  }

  return [...args, ...settingsArgs];
}

function coalesceCodexExecEvent(event: RunnerEvent, assistantText: string): {
  event: RunnerEvent;
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

async function flushCodexExecBuffer(input: {
  buffer: string;
  assistantText: string;
  events: RunnerEvent[];
  onEvent?: (event: RunnerEvent) => void;
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
      await onRunnerEvent(input.onEvent, coalesced.event);
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
          await onRunnerEvent(input.onEvent, coalesced.event);
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

function parseCodexExecLine(line: string): { event?: RunnerEvent; threadId?: string } | undefined {
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
            toolName: "command_execution",
            content: "command_execution",
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
            toolName: "collab_tool_call",
            content: "collab_tool_call",
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

async function onRunnerEvent(
  onEvent: ((event: RunnerEvent) => void | Promise<void>) | undefined,
  event: RunnerEvent,
) {
  if (!onEvent) {
    return;
  }

  await onEvent(event);
}

function extractCodexExecFailure(stderr: unknown): string | undefined {
  if (typeof stderr !== "string") {
    return undefined;
  }

  const normalized = stderr
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  return normalized[0];
}

function extractGitRepositoryError(stderr: unknown): string | undefined {
  const message = extractCodexExecFailure(stderr);
  if (!message) {
    return undefined;
  }

  if (message.includes("not a git repository")) {
    return "请先切到一个 Codex 项目目录，再新建会话。";
  }

  return message;
}

function isNotGitRepositoryError(stderr: unknown): boolean {
  const message = extractCodexExecFailure(stderr);
  return typeof message === "string" && message.includes("not a git repository");
}

function insertArgsBeforeTrailing(
  args: string[],
  insertedArgs: string[],
  trailingArgsCount: number,
): string[] {
  if (insertedArgs.length === 0) {
    return args;
  }

  if (trailingArgsCount <= 0 || trailingArgsCount > args.length) {
    return [...args, ...insertedArgs];
  }

  const insertIndex = args.length - trailingArgsCount;
  const prefixArgs = args.slice(0, insertIndex);
  const trailingArgs = args.slice(insertIndex);
  return [...prefixArgs, ...insertedArgs, ...trailingArgs];
}
