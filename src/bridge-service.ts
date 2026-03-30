import { randomUUID } from "node:crypto";
import path from "node:path";

import { BRIDGE_COMMAND_PREFIX, routeBridgeInput } from "./command-router.js";
import { buildBridgeHubCard } from "./feishu-card/navigation-card-builder.js";
import type { ProjectThreadService } from "./project-thread-service.js";
import { createProgressCardState, reduceProgressEvent } from "./progress-relay.js";
import type {
  AcpxEvent,
  BridgeMessageInput,
  BridgeLifecycleStage,
  BridgeReply,
  CodexCatalogConversationItem,
  CodexCatalogProject,
  CodexCatalogThread,
  PendingPlanInteractionRecord,
  RootProfile,
  ProgressCardState,
  RunContext,
  RunOutcome,
} from "./types.js";
import { SessionStore } from "./workspace/session-store.js";

interface BridgeRunner {
  createThread(
    input: {
      cwd: string;
      prompt: string;
    },
    onEvent?: (event: AcpxEvent) => void,
  ): Promise<RunOutcome & { threadId: string }>;
  ensureSession(context: RunContext): Promise<void>;
  submitVerbatim(
    context: RunContext,
    prompt: string,
    onEvent?: (event: AcpxEvent) => void,
  ): Promise<RunOutcome>;
  cancel(context: RunContext): Promise<void>;
  close(context: RunContext): Promise<void>;
}

interface ResolvedContext {
  root: RootProfile;
  context: RunContext;
  wrapPrompt: boolean;
  sessionName: string;
  projectId: string | null;
  threadId: string | null;
  deliveryChatId: string | null;
  deliverySurfaceType: "thread" | null;
  deliverySurfaceRef: string | null;
  concurrencyKey: string;
}

interface RunWorkerManagerLike {
  schedule<T>(concurrencyKey: string, worker: () => Promise<T>): Promise<T>;
}

interface CodexCatalogLike {
  listProjects(options?: { includeArchived?: boolean }): CodexCatalogProject[];
  getProject(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogProject | undefined;
  listThreads(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogThread[];
  getThread(threadId: string): CodexCatalogThread | undefined;
  listRecentConversation(threadId: string, limit?: number): CodexCatalogConversationItem[];
}

export class BridgeService {
  public constructor(
    private readonly dependencies: {
      store: SessionStore;
      runner: BridgeRunner;
      workerManager?: RunWorkerManagerLike;
      projectThreadService?: Pick<ProjectThreadService, "createThread" | "linkThread">;
      codexCatalog?: CodexCatalogLike;
    },
  ) {}

  public async handleMessage(input: BridgeMessageInput, options?: {
    onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
  }): Promise<BridgeReply[]> {
    const routed = routeBridgeInput(input.text);

    if (routed.kind === "command") {
      return this.handleCommand(input, routed.command.name, routed.command.args);
    }

    const resolved = this.resolveContext(input);
    let currentProgress = createProgressCardState({
      runId: buildRunId(),
      rootName: resolved.root.id,
      sessionName: resolved.sessionName,
      deliveryChatId: resolved.deliveryChatId,
      deliverySurfaceType: resolved.deliverySurfaceType,
      deliverySurfaceRef: resolved.deliverySurfaceRef,
    });

    const emitSnapshot = async (
      snapshot: ProgressCardState,
      source: "bridge" | "acpx" | "system",
      toolName?: string,
      coalesceSimilar = false,
    ) => {
      currentProgress = snapshot;
      this.dependencies.store.appendRunEvent({
        runId: currentProgress.runId,
        source,
        status: currentProgress.status,
        stage: currentProgress.stage,
        preview: currentProgress.preview,
        toolName,
        coalesceSimilar,
      });
      await options?.onProgress?.(currentProgress);
    };

    const emitLifecycle = async (
      stage: BridgeLifecycleStage,
      content?: string,
      sessionName?: string,
    ) => {
      const snapshot = reduceProgressEvent(currentProgress, {
        type: "bridge_lifecycle",
        stage,
        content,
        sessionName,
      });
      await emitSnapshot(snapshot, "bridge");
    };

    const executeRun = async (): Promise<BridgeReply[]> => {
      let activeResolved = resolved;

      this.dependencies.store.createRun({
        runId: currentProgress.runId,
        channel: input.channel,
        peerId: input.peerId,
        projectId: activeResolved.projectId,
        threadId: activeResolved.threadId,
        deliveryChatId: activeResolved.deliveryChatId,
        deliverySurfaceType: activeResolved.deliverySurfaceType,
        deliverySurfaceRef: activeResolved.deliverySurfaceRef,
        sessionName: activeResolved.sessionName,
        rootId: activeResolved.root.id,
        status: currentProgress.status,
        stage: currentProgress.stage,
        latestPreview: currentProgress.preview,
      });

      if (activeResolved.context.targetKind === "new_codex_thread") {
        activeResolved = await this.materializeNativeContext(input, activeResolved, routed.prompt);
        currentProgress = {
          ...currentProgress,
          sessionName: activeResolved.sessionName,
        };
        this.dependencies.store.updateRunContext({
          runId: currentProgress.runId,
          sessionName: activeResolved.sessionName,
          threadId: activeResolved.threadId,
          projectId: activeResolved.projectId,
          deliveryChatId: activeResolved.deliveryChatId,
          deliverySurfaceType: activeResolved.deliverySurfaceType,
          deliverySurfaceRef: activeResolved.deliverySurfaceRef,
        });
      }

      if (activeResolved.threadId) {
        this.dependencies.store.updateCodexThreadState({
          threadId: activeResolved.threadId,
          status: "running",
          lastRunId: currentProgress.runId,
        });
      }

      await emitLifecycle("received", "[ca] received", activeResolved.sessionName);
      await emitLifecycle("resolving_context", "[ca] resolving context", activeResolved.sessionName);
      await emitLifecycle("ensuring_session", "[ca] ensuring session", activeResolved.sessionName);
      await this.dependencies.runner.ensureSession(activeResolved.context);
      await emitLifecycle(
        "session_ready",
        `[ca] session ready: ${activeResolved.sessionName}`,
        activeResolved.sessionName,
      );
      await emitLifecycle("submitting_prompt", "[ca] submitting prompt", activeResolved.sessionName);
      await emitLifecycle(
        "waiting_first_event",
        "[ca] waiting for Codex response",
        activeResolved.sessionName,
      );

      const outcome = await this.dependencies.runner.submitVerbatim(
        activeResolved.context,
        activeResolved.wrapPrompt
          ? buildCodexPromptEnvelope(activeResolved.root, routed.prompt)
          : routed.prompt,
        async event => {
          let snapshot = reduceProgressEvent(currentProgress, event);
          if (event.type === "text" && event.planInteraction && activeResolved.threadId) {
            const interaction = this.dependencies.store.savePendingPlanInteraction({
              runId: currentProgress.runId,
              channel: input.channel,
              peerId: input.peerId,
              chatId: activeResolved.deliveryChatId,
              surfaceType: activeResolved.deliverySurfaceType,
              surfaceRef: activeResolved.deliverySurfaceRef,
              threadId: activeResolved.threadId,
              sessionName: activeResolved.sessionName,
              question: event.planInteraction.question,
              choices: event.planInteraction.choices,
            });
            snapshot = {
              ...snapshot,
              planInteraction: interaction,
            };
          }
          await emitSnapshot(
            snapshot,
            "acpx",
            event.type === "tool_call" ? event.toolName : undefined,
            event.type === "text" || event.type === "waiting",
          );
        },
      );

      const finalText = findFinalAssistantText(outcome.events);

      if (currentProgress.status === "error" || outcome.exitCode !== 0) {
        const errorText = currentProgress.status === "error"
          ? extractErrorText(currentProgress.preview)
          : `RUN_EXITED_${outcome.exitCode}`;
        this.dependencies.store.completeRun({
          runId: currentProgress.runId,
          status: "error",
          stage: "error",
          latestPreview: currentProgress.preview,
          latestTool: currentProgress.latestTool ?? null,
          errorText,
        });
        throw new Error(errorText);
      }

      if (!isTerminalProgress(currentProgress)) {
        const snapshot = reduceProgressEvent(currentProgress, {
          type: "done",
          content: finalText,
        });
        await emitSnapshot(snapshot, "system");
      }

      this.dependencies.store.completeRun({
        runId: currentProgress.runId,
        status: currentProgress.status,
        stage: currentProgress.stage,
        latestPreview: currentProgress.preview,
        latestTool: currentProgress.latestTool ?? null,
      });

      if (activeResolved.threadId) {
        this.dependencies.store.updateCodexThreadState({
          threadId: activeResolved.threadId,
          status: "warm",
          lastRunId: currentProgress.runId,
        });
      }

      return [
        {
          kind: "assistant",
          text: finalText,
        },
      ];
    };

    const executeWithErrorHandling = async (): Promise<BridgeReply[]> => {
      try {
        return await executeRun();
      } catch (error) {
        const errorText = normalizeRunError(error);
        if (
          currentProgress.status !== "error" ||
          extractErrorText(currentProgress.preview) !== errorText
        ) {
          const errorSnapshot = reduceProgressEvent(currentProgress, {
            type: "error",
            content: errorText,
          });
          await emitSnapshot(errorSnapshot, "system");
        }

        this.dependencies.store.completeRun({
          runId: currentProgress.runId,
          status: "error",
          stage: "error",
          latestPreview: currentProgress.preview,
          latestTool: currentProgress.latestTool ?? null,
          errorText,
        });

        if (resolved.threadId) {
          this.dependencies.store.updateCodexThreadState({
            threadId: resolved.threadId,
            status: "warm",
            lastRunId: currentProgress.runId,
          });
        }

        throw error instanceof Error ? error : new Error(errorText);
      }
    };

    if (!this.dependencies.workerManager) {
      return executeWithErrorHandling();
    }

    return this.dependencies.workerManager.schedule(resolved.concurrencyKey, executeWithErrorHandling);
  }

  public getPendingPlanInteraction(interactionId: string): PendingPlanInteractionRecord | undefined {
    return this.dependencies.store.getPendingPlanInteraction(interactionId);
  }

  public async handlePlanChoice(input: {
    channel: string;
    peerId: string;
    interactionId: string;
    choiceId: string;
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  }, options?: {
    onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
  }): Promise<BridgeReply[]> {
    const interaction = this.dependencies.store.getPendingPlanInteraction(input.interactionId);
    if (!interaction || interaction.status !== "pending") {
      return [{
        kind: "system",
        text: "[ca] pending plan interaction not found",
      }];
    }
    if (!matchesPlanInteractionSurface(interaction, input)) {
      return [{
        kind: "system",
        text: "[ca] pending plan interaction surface mismatch",
      }];
    }

    const choice = interaction.choices.find(item => item.choiceId === input.choiceId);
    if (!choice) {
      return [{
        kind: "system",
        text: "[ca] pending plan choice not found",
      }];
    }

    if (!input.chatId && !input.surfaceType) {
      const binding = this.dependencies.store.getCodexWindowBinding(input.channel, input.peerId);
      if (!binding || binding.codexThreadId !== interaction.threadId) {
        this.dependencies.store.bindCodexWindow({
          channel: input.channel,
          peerId: input.peerId,
          codexThreadId: interaction.threadId,
        });
      }
    }

    this.dependencies.store.resolvePendingPlanInteraction({
      interactionId: interaction.interactionId,
      selectedChoiceId: choice.choiceId,
    });

    return this.handleMessage(
      {
        channel: input.channel,
        peerId: input.peerId,
        chatId: input.chatId,
        surfaceType: input.surfaceType,
        surfaceRef: input.surfaceRef,
        text: choice.responseText,
      },
      options,
    );
  }

  private async handleCommand(
    input: BridgeMessageInput,
    commandName: string,
    args: string[],
  ): Promise<BridgeReply[]> {
    switch (commandName) {
      case "help":
      case "hub":
        return this.handleHubCommand(input);
      case "status": {
        const root = this.dependencies.store.getRoot();
        const resolved = this.tryResolveContext(input);

        return [
          {
            kind: "system",
            text: `[ca] root=${root?.id ?? "unconfigured"} session=${resolved?.sessionName ?? "none"} status=idle`,
          },
        ];
      }
      case "new": {
        const resolved = this.resolveContext(input);
        const currentThread = input.surfaceType === "thread" && input.chatId && input.surfaceRef
          ? this.dependencies.store.getCodexThreadBySurface(input.chatId, input.surfaceRef)
          : undefined;
        const created = await this.dependencies.runner.createThread({
          cwd: resolved.context.cwd,
          prompt: buildNativeThreadBootstrapPrompt(currentThread?.title ?? resolved.threadId ?? resolved.sessionName),
        });

        if (input.surfaceType === "thread" && input.chatId && input.surfaceRef) {
          this.dependencies.store.rebindCodexThreadSurface({
            chatId: input.chatId,
            feishuThreadId: input.surfaceRef,
            threadId: created.threadId,
            sessionName: created.threadId,
            title: resolved.threadId ?? resolved.sessionName,
            status: "warm",
          });
          return [{ kind: "system", text: `[ca] thread reset to ${created.threadId}` }];
        }

        this.dependencies.store.bindCodexWindow({
          channel: input.channel,
          peerId: input.peerId,
          codexThreadId: created.threadId,
        });
        return [{ kind: "system", text: `[ca] thread switched to ${created.threadId}` }];
      }
      case "stop": {
        return [{ kind: "system", text: "[ca] stop unavailable for native Codex threads" }];
      }
      case "session": {
        const codexSelection = this.lookupDmCodexSelection(input);
        if (codexSelection) {
          const recentConversation = this.dependencies.codexCatalog?.listRecentConversation(codexSelection.thread.threadId) ?? [];
          return [
            this.buildCurrentCodexSessionCardReply(
              input,
              codexSelection.project,
              codexSelection.thread,
              selectSwitchCardConversation(recentConversation),
            ),
          ];
        }

        const resolved = this.resolveContext(input);
        return [{ kind: "system", text: `[ca] session=${resolved.sessionName}` }];
      }
      case "logs": {
        const resolved = this.resolveContext(input);
        return [{ kind: "system", text: `[ca] logs session=${resolved.sessionName}` }];
      }
      case "project":
        return this.handleProjectCommand(input, args);
      case "thread":
        return this.handleThreadCommand(input, args);
      default:
        return this.handleHubCommand(input);
    }
  }

  private handleHubCommand(input: BridgeMessageInput): BridgeReply[] {
    const root = this.dependencies.store.getRoot();
    if (!root) {
      throw new Error("ROOT_NOT_CONFIGURED");
    }

    const summaryLines = [`**Root**：${root.id}`, `**Root 路径**：${root.cwd}`];
    const sections: Array<{ title: string; items: string[]; monospace?: boolean }> = [];
    const actionContext = this.buildCardActionContext(input);
    const actions: Array<{
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }> = [{
      label: "导航",
      type: "primary",
      value: this.buildCardActionValue(actionContext, BRIDGE_COMMAND_PREFIX),
    }];

    if (input.surfaceType === "thread" && input.chatId && input.surfaceRef) {
      const thread = this.dependencies.store.getCodexThreadBySurface(input.chatId, input.surfaceRef);
      if (!thread) {
        throw new Error("THREAD_NOT_REGISTERED");
      }

      const project = this.dependencies.store.getProject(thread.projectId);
      if (!project) {
        throw new Error("PROJECT_NOT_REGISTERED");
      }

      summaryLines.push(`**当前项目**：${project.projectId}`);
      summaryLines.push(`**当前线程**：${thread.threadId} · ${thread.title}`);
      summaryLines.push(`**Session**：${thread.sessionName}`);
      summaryLines.push(`**线程状态**：${thread.status ?? "provisioned"}`);
      const siblingThreads = this.dependencies.store.listProjectThreads(project.projectId).slice(0, 5);
      if (siblingThreads.length > 0) {
        sections.push({
          title: "当前项目线程",
          items: siblingThreads.map(
            item => `${item.threadId} · ${item.title} · status=${item.status}`,
          ),
        });
      }
        actions.push(
          {
            label: "当前项目",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} project current`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
          {
            label: "计划模式",
            value: this.buildPlanActionValue(actionContext),
          },
          {
            label: "当前会话",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} session`),
          },
        {
          label: "新会话",
          value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} new`),
        },
        {
          label: "停止",
          type: "danger",
          value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} stop`),
        },
      );
    } else if (input.chatId) {
      const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);

      if (projectChat) {
        const project = this.dependencies.store.getProject(projectChat.projectId);
        if (!project) {
          throw new Error("PROJECT_NOT_REGISTERED");
        }

        summaryLines.push(`**当前项目**：${project.projectId}`);
        summaryLines.push(`**项目名**：${project.name}`);
        summaryLines.push(`**项目路径**：${project.cwd}`);
        summaryLines.push(`**群聊**：${projectChat.chatId}`);
        const projectThreads = this.dependencies.store.listProjectThreads(project.projectId).slice(0, 5);
        if (projectThreads.length > 0) {
          sections.push({
            title: "当前项目线程",
            items: projectThreads.map(
              item => `${item.threadId} · ${item.title} · status=${item.status}`,
            ),
          });
        }
        actions.push(
          {
            label: "当前项目",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} project current`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
          {
            label: "项目列表",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} project list`),
          },
        );
      } else {
        summaryLines.push("**当前项目**：未绑定");
        sections.push({
          title: "先完成项目绑定",
          items: ["当前群还没绑定项目，可先查看项目列表或直接发送绑定命令。"],
        });
        actions.push({
          label: "项目列表",
          value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} project list`),
        });
      }
    } else {
      const codexSelection = this.lookupDmCodexSelection(input);

      if (codexSelection) {
        summaryLines.push(`**当前项目**：${codexSelection.project.displayName}`);
        summaryLines.push(`**项目路径**：${codexSelection.project.cwd}`);
        summaryLines.push(`**当前线程**：${codexSelection.thread.threadId} · ${codexSelection.thread.title}`);
        summaryLines.push(`**Session**：${codexSelection.thread.threadId}`);
          actions.push(
            {
              label: "项目列表",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} project list`),
            },
            {
              label: "当前项目",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} project current`),
            },
            {
              label: "线程列表",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} thread list-current`),
            },
            {
              label: "计划模式",
              value: this.buildPlanActionValue(actionContext),
            },
            {
              label: "当前会话",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} session`),
            },
          {
            label: "新会话",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} new`),
          },
        );
      } else {
        const binding = this.dependencies.store.getBinding(input.channel, input.peerId);
        summaryLines.push(`**当前会话**：${binding?.sessionName ?? buildSessionName(root.id)}`);
        const catalogProjects = this.dependencies.codexCatalog?.listProjects().slice(0, 8) ?? [];
        if (catalogProjects.length > 0) {
          sections.push({
            title: "Codex 项目概览",
            items: catalogProjects.map(
              project => `${project.displayName} · threads=${project.threadCount} · path=${project.cwd}`,
            ),
          });
        } else {
          const bridgeProjects = this.dependencies.store.listProjects().slice(0, 8);
          if (bridgeProjects.length > 0) {
            sections.push({
              title: "项目概览",
              items: bridgeProjects.map(
                project => `${project.projectId} · chat=${project.chatId ?? "unbound"} · threads=${project.threadCount}`,
              ),
            });
          }
        }
          actions.push(
            {
              label: "会话状态",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} status`),
            },
            {
              label: "当前会话",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} session`),
            },
            {
              label: "新会话",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} new`),
            },
            {
              label: "计划模式",
              value: this.buildPlanActionValue(actionContext),
            },
            {
              label: "项目列表",
              value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} project list`),
            },
        );
      }
    }

    return [{
      kind: "card",
      card: buildBridgeHubCard({
        summaryLines,
        sections,
        actions,
      }),
    }];
  }

  private async handleProjectCommand(
    input: BridgeMessageInput,
    args: string[],
  ): Promise<BridgeReply[]> {
    const [action = "help", rawProjectId, rawChatIdOrCwd, rawCwdOrName, ...rest] = args;
    const projectCommandHelp =
      `[ca] project commands: ${BRIDGE_COMMAND_PREFIX} project bind <projectId> <chatId> <cwd> [name], ${BRIDGE_COMMAND_PREFIX} project bind-current <projectId> <cwd> [name], ${BRIDGE_COMMAND_PREFIX} project current, ${BRIDGE_COMMAND_PREFIX} project list`;

    if (action === "list") {
      if (this.isDmContext(input) && this.dependencies.codexCatalog) {
        const projects = this.dependencies.codexCatalog.listProjects();
        return [this.buildCodexProjectListCardReply(input, projects)];
      }
      const projects = this.dependencies.store.listProjects();
      return [this.buildProjectListCardReply(input, projects)];
    }

    if (action === "threads" && this.isDmContext(input) && this.dependencies.codexCatalog) {
      if (!rawProjectId) {
        return [{ kind: "system", text: projectCommandHelp }];
      }

      const project = this.dependencies.codexCatalog.getProject(rawProjectId);
      if (!project) {
        return [this.buildCodexProjectUnavailableCardReply(input)];
      }

      const threads = this.dependencies.codexCatalog.listThreads(project.projectKey);
      return [this.buildCodexThreadListCardReply(input, project, threads)];
    }

    if (action === "current") {
      if (this.isDmContext(input) && this.dependencies.codexCatalog) {
        const codexSelection = this.lookupDmCodexSelection(input);
        if (!codexSelection) {
          return [{ kind: "system", text: "[ca] current project: none" }];
        }

        return [this.buildCurrentCodexProjectCardReply(input, codexSelection.project, codexSelection.thread)];
      }

      if (!input.chatId) {
        return [{ kind: "system", text: "[ca] current project: none" }];
      }

      const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
      if (!projectChat) {
        return [{ kind: "system", text: "[ca] current project: none" }];
      }

      const project = this.dependencies.store.getProject(projectChat.projectId);
      if (!project) {
        throw new Error("PROJECT_NOT_REGISTERED");
      }

      return [this.buildCurrentProjectCardReply({
        projectId: project.projectId,
        projectName: project.name,
        chatId: projectChat.chatId,
        cwd: project.cwd,
      })];
    }

    const isBindCurrent = action === "bind-current";
    const isBind = action === "bind";
    if (
      (!isBindCurrent && !isBind) ||
      !rawProjectId ||
      !rawChatIdOrCwd ||
      (!isBindCurrent && !rawCwdOrName)
    ) {
      return [{
        kind: "system",
        text: projectCommandHelp,
      }];
    }

    const root = this.dependencies.store.getRoot();
    if (!root) {
      throw new Error("ROOT_NOT_CONFIGURED");
    }

    const projectId = rawProjectId;
    const chatId = isBindCurrent ? input.chatId : rawChatIdOrCwd;
    const cwdArg = isBindCurrent ? rawChatIdOrCwd : rawCwdOrName;
    const nameParts = isBindCurrent ? [rawCwdOrName, ...rest] : rest;
    if (!chatId || !cwdArg) {
      throw new Error("PROJECT_CHAT_CONTEXT_REQUIRED");
    }

    const name = nameParts.filter(Boolean).join(" ").trim() || projectId;
    const resolvedCwd = path.isAbsolute(cwdArg)
      ? cwdArg
      : path.resolve(root.cwd, cwdArg);

    this.dependencies.store.createProject({
      projectId,
      name,
      cwd: resolvedCwd,
      repoRoot: resolvedCwd,
    });
    this.dependencies.store.upsertProjectChat({
      projectId,
      chatId,
      groupMessageType: "thread",
      title: `Codex | ${name}`,
    });

    return [{ kind: "system", text: `[ca] project bound: ${projectId} -> ${chatId}` }];
  }

  private async handleThreadCommand(
    input: BridgeMessageInput,
    args: string[],
  ): Promise<BridgeReply[]> {
    const [action = "help", ...restArgs] = args;
    const [projectId, ...rest] = restArgs;
    const threadCommandHelp =
      `[ca] thread commands: ${BRIDGE_COMMAND_PREFIX} thread create <projectId> <title>, ${BRIDGE_COMMAND_PREFIX} thread create-current <title>, ${BRIDGE_COMMAND_PREFIX} thread list <projectId>, ${BRIDGE_COMMAND_PREFIX} thread list-current`;

    if (action === "switch" && this.dependencies.codexCatalog) {
      const threadId = restArgs[0];
      if (!threadId) {
        return [{ kind: "system", text: threadCommandHelp }];
      }

      const thread = this.dependencies.codexCatalog.getThread(threadId);
      if (!thread) {
        return [this.buildCodexThreadUnavailableCardReply(input)];
      }

      const project = this.dependencies.codexCatalog.getProject(thread.projectKey, {
        includeArchived: true,
      });
      if (!project) {
        return [this.buildCodexProjectUnavailableCardReply(input)];
      }

      if (this.isDmContext(input)) {
        this.dependencies.store.bindCodexWindow({
          channel: input.channel,
          peerId: input.peerId,
          codexThreadId: thread.threadId,
        });

        const recentConversation = this.dependencies.codexCatalog.listRecentConversation(thread.threadId);
        return [
          this.buildCodexThreadSwitchedCardReply(
            input,
            project,
            thread,
            selectSwitchCardConversation(recentConversation),
          ),
        ];
      }

      if (input.surfaceType === "thread" && input.chatId && input.surfaceRef) {
        this.dependencies.store.rebindCodexThreadSurface({
          chatId: input.chatId,
          feishuThreadId: input.surfaceRef,
          threadId: thread.threadId,
          sessionName: thread.threadId,
          title: thread.title,
          status: "warm",
        });
        return [{ kind: "system", text: `[ca] thread switched to ${thread.threadId}` }];
      }

      if (input.chatId && this.dependencies.projectThreadService) {
        const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
        if (!projectChat) {
          throw new Error("PROJECT_CHAT_CONTEXT_REQUIRED");
        }

        const linkedThread = await this.dependencies.projectThreadService.linkThread({
          projectId: projectChat.projectId,
          chatId: projectChat.chatId,
          ownerOpenId: input.peerId,
          title: thread.title,
          codexThreadId: thread.threadId,
        });
        return [this.buildThreadCreatedCardReply(linkedThread)];
      }
    }

    if (action === "list" || action === "list-current") {
      if (action === "list-current" && this.dependencies.codexCatalog) {
        if (this.isDmContext(input)) {
          const codexSelection = this.lookupDmCodexSelection(input);
          if (!codexSelection) {
            return [{ kind: "system", text: threadCommandHelp }];
          }

          const threads = this.dependencies.codexCatalog.listThreads(codexSelection.project.projectKey);
          return [this.buildCodexThreadListCardReply(input, codexSelection.project, threads)];
        }

        const project = this.lookupCatalogProjectForSurface(input);
        if (project) {
          const threads = this.dependencies.codexCatalog.listThreads(project.project.projectKey);
          return [this.buildCodexThreadListCardReply(input, project.project, threads)];
        }
      }

      const effectiveProjectId = action === "list-current"
        ? input.chatId
          ? this.dependencies.store.getProjectChatByChatId(input.chatId)?.projectId
          : undefined
        : projectId;

      if (!effectiveProjectId) {
        return [{ kind: "system", text: threadCommandHelp }];
      }

      const threads = this.dependencies.store.listProjectThreads(effectiveProjectId);
      return [this.buildThreadListCardReply(input, effectiveProjectId, threads)];
    }

    const isCreateCurrent = action === "create-current";
    const isCreate = action === "create";
    const hasTitle = isCreateCurrent ? restArgs.length > 0 : rest.length > 0;
    if ((!isCreateCurrent && !isCreate) || (isCreate && !projectId) || !hasTitle) {
      return [{ kind: "system", text: threadCommandHelp }];
    }

    const projectChat = isCreateCurrent
      ? input.chatId
        ? this.dependencies.store.getProjectChatByChatId(input.chatId)
        : undefined
      : this.dependencies.store.getProjectChat(projectId);

    if (!projectChat) {
      throw new Error(isCreateCurrent ? "PROJECT_CHAT_CONTEXT_REQUIRED" : "PROJECT_CHAT_NOT_CONFIGURED");
    }
    if (!this.dependencies.projectThreadService) {
      throw new Error("PROJECT_THREAD_SERVICE_NOT_CONFIGURED");
    }

    const effectiveProjectId = isCreateCurrent ? projectChat.projectId : projectId;
    const project = this.dependencies.store.getProject(effectiveProjectId);
    if (!project) {
      throw new Error("PROJECT_NOT_REGISTERED");
    }
    const titleParts = isCreateCurrent ? restArgs : rest;
    const title = titleParts.join(" ").trim();
    const thread = await this.dependencies.projectThreadService.createThread({
      projectId: effectiveProjectId,
      cwd: project.cwd,
      chatId: projectChat.chatId,
      ownerOpenId: input.peerId,
      title,
    });

    return [this.buildThreadCreatedCardReply(thread)];
  }

  private resolveContext(input: BridgeMessageInput): ResolvedContext {
    const root = this.dependencies.store.getRoot();
    if (!root) {
      throw new Error("ROOT_NOT_CONFIGURED");
    }

    if (input.surfaceType === "thread" && input.chatId && input.surfaceRef) {
      const thread = this.dependencies.store.getCodexThreadBySurface(input.chatId, input.surfaceRef);
      if (!thread) {
        throw new Error("THREAD_NOT_REGISTERED");
      }

      const project = this.dependencies.store.getProject(thread.projectId);
      if (!project) {
        throw new Error("PROJECT_NOT_REGISTERED");
      }

      const isNativeThread = this.isNativeCatalogThread(thread.threadId);
      if (isNativeThread) {
        return {
          root,
          wrapPrompt: true,
          sessionName: thread.threadId,
          projectId: thread.projectId,
          threadId: thread.threadId,
          deliveryChatId: input.chatId,
          deliverySurfaceType: "thread",
          deliverySurfaceRef: input.surfaceRef,
          concurrencyKey: thread.threadId,
          context: {
            targetKind: "codex_thread",
            threadId: thread.threadId,
            sessionName: thread.threadId,
            cwd: project.cwd,
          },
        };
      }

      return {
        root,
        wrapPrompt: true,
        sessionName: thread.sessionName,
        projectId: thread.projectId,
        threadId: null,
        deliveryChatId: input.chatId,
        deliverySurfaceType: "thread",
        deliverySurfaceRef: input.surfaceRef,
        concurrencyKey: `pending-codex-thread:${input.chatId}:${input.surfaceRef}`,
        context: {
          targetKind: "new_codex_thread",
          sessionName: thread.sessionName,
          threadTitle: thread.title,
          cwd: project.cwd,
        },
      };
    }

    const codexSelection = this.lookupDmCodexSelection(input);
    if (codexSelection) {
      return {
        root,
        wrapPrompt: false,
        sessionName: codexSelection.thread.threadId,
        projectId: codexSelection.project.projectKey,
        threadId: codexSelection.thread.threadId,
        deliveryChatId: null,
        deliverySurfaceType: null,
        deliverySurfaceRef: null,
        concurrencyKey: `codex-thread:${codexSelection.thread.threadId}`,
        context: {
          targetKind: "codex_thread",
          threadId: codexSelection.thread.threadId,
          sessionName: codexSelection.thread.threadId,
          cwd: codexSelection.thread.cwd,
        },
      };
    }

    return {
      root,
      wrapPrompt: true,
      sessionName: buildSessionName(root.id),
      projectId: null,
      threadId: null,
      deliveryChatId: null,
      deliverySurfaceType: null,
      deliverySurfaceRef: null,
      concurrencyKey: `pending-codex-thread:${input.channel}:${input.peerId}`,
      context: {
        targetKind: "new_codex_thread",
        sessionName: buildSessionName(root.id),
        cwd: root.cwd,
      },
    };
  }

  private tryResolveContext(input: BridgeMessageInput): ResolvedContext | undefined {
    try {
      return this.resolveContext(input);
    } catch {
      return undefined;
    }
  }

  private buildProjectListCardReply(
    input: BridgeMessageInput,
    projects: Array<{
      projectId: string;
      chatId: string | null;
      threadCount: number;
      runningThreadCount: number;
    }>,
  ): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "项目列表",
        summaryLines: [
          "**视图**：项目列表",
          `**项目数**：${projects.length}`,
        ],
        sections: projects.length > 0
          ? [
              {
                title: "项目列表",
                items: projects.map(
                  project =>
                    `${project.projectId} · chat=${project.chatId ?? "unbound"} · threads=${project.threadCount} · running=${project.runningThreadCount}`,
                ),
              },
            ]
          : [
              {
                title: "暂无已注册项目",
                items: ["先绑定一个项目群，之后这里会展示项目列表。"],
              },
            ],
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), BRIDGE_COMMAND_PREFIX),
          },
          {
            label: "项目列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project list`),
          },
          ...(!this.isDmContext(input) && input.chatId
            ? [{
                label: "当前项目",
                value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project current`),
              }]
            : []),
        ],
      }),
    };
  }

  private buildThreadListCardReply(
    input: BridgeMessageInput,
    projectId: string,
    threads: Array<{
      threadId: string;
      title: string;
      status: string;
    }>,
  ): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "线程列表",
        summaryLines: [
          "**视图**：线程列表",
          `**当前项目**：${projectId}`,
          `**线程数**：${threads.length}`,
        ],
        sections: threads.length > 0
          ? [
              {
                title: "线程列表",
                items: threads.map(
                  thread => `${thread.threadId} · ${thread.title} · status=${thread.status}`,
                ),
              },
            ]
          : [
              {
                title: "暂无线程",
                items: ["当前项目还没有已注册的线程。"],
              },
            ],
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), BRIDGE_COMMAND_PREFIX),
          },
          {
            label: "当前项目",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project current`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
        ],
      }),
    };
  }

  private buildCurrentProjectCardReply(input: {
    projectId: string;
    projectName: string;
    chatId: string;
    cwd: string;
  }): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前项目",
        summaryLines: [
          "**视图**：当前项目",
          `**项目**：${input.projectId}`,
          `**项目名**：${input.projectName}`,
          `**群聊**：${input.chatId}`,
          `**路径**：${input.cwd}`,
        ],
        sections: [
          {
            title: "当前项目",
            items: ["可直接查看线程列表，或在群里继续发送带标题的建线程命令。"],
          },
        ],
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue({ chatId: input.chatId }, BRIDGE_COMMAND_PREFIX),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue({ chatId: input.chatId }, `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
        ],
      }),
    };
  }

  private buildThreadCreatedCardReply(input: {
    threadId: string;
    projectId: string;
    chatId: string;
    sessionName: string;
    title: string;
    status?: string;
  }): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "线程已创建",
        summaryLines: [
          "**视图**：线程已创建",
          `**项目**：${input.projectId}`,
          `**线程**：${input.threadId}`,
          `**标题**：${input.title}`,
          `**Session**：${input.sessionName}`,
          `**群聊**：${input.chatId}`,
          `**状态**：${input.status ?? "provisioned"}`,
        ],
        sections: [
          {
            title: "下一步",
            items: ["可以返回导航，或继续查看当前项目和线程列表。"],
          },
        ],
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue({ chatId: input.chatId }, BRIDGE_COMMAND_PREFIX),
          },
          {
            label: "当前项目",
            value: this.buildCardActionValue({ chatId: input.chatId }, `${BRIDGE_COMMAND_PREFIX} project current`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue({ chatId: input.chatId }, `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
        ],
      }),
    };
  }

  private buildCodexProjectListCardReply(
    input: BridgeMessageInput,
    projects: CodexCatalogProject[],
  ): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "项目列表",
        summaryLines: [
          "**视图**：Codex 项目列表",
          `**项目数**：${projects.length}`,
        ],
        sections: projects.length > 0
          ? []
          : [
              {
                title: "暂无可浏览项目",
                items: ["当前 Codex 线程库中没有可用项目。"],
              },
            ],
        rows: projects.map(project => ({
          title: project.displayName,
          lines: [
            `路径：${project.cwd}`,
            `线程：${project.activeThreadCount}/${project.threadCount}`,
            `最近更新：${project.lastUpdatedAt}`,
          ],
          buttonLabel: "查看线程",
          value: this.buildCardActionValue(
            this.buildCardActionContext(input),
            `${BRIDGE_COMMAND_PREFIX} project threads ${project.projectKey}`,
          ),
        })),
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} hub`),
          },
          {
            label: "项目列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project list`),
          },
        ],
      }),
    };
  }

  private buildCodexThreadListCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
    threads: CodexCatalogThread[],
  ): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "线程列表",
        summaryLines: [
          "**视图**：Codex 线程列表",
          `**当前项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `**线程数**：${threads.length}`,
        ],
        sections: threads.length > 0
          ? []
          : [
              {
                title: "暂无线程",
                items: ["当前项目下没有可切换的 Codex 线程。"],
              },
            ],
        rows: threads.map(thread => ({
          title: thread.title,
          lines: [
            `线程 ID：${thread.threadId}`,
            `来源：${thread.source} · 分支：${thread.gitBranch ?? "unknown"}`,
            `最近更新：${thread.updatedAt}`,
          ],
          buttonLabel: "切换到此线程",
          value: this.buildCardActionValue(
            this.buildCardActionContext(input),
            `${BRIDGE_COMMAND_PREFIX} thread switch ${thread.threadId}`,
          ),
        })),
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} hub`),
          },
          {
            label: "项目列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project list`),
          },
        ],
      }),
    };
  }

  private buildCurrentCodexProjectCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
    thread: CodexCatalogThread,
  ): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前项目",
        summaryLines: [
          "**视图**：当前项目",
          `**项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `**当前线程**：${thread.threadId} · ${thread.title}`,
        ],
        sections: [],
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), BRIDGE_COMMAND_PREFIX),
          },
          {
            label: "当前会话",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} session`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
        ],
      }),
    };
  }

  private buildCurrentCodexSessionCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
    thread: CodexCatalogThread,
    recentConversation: CodexCatalogConversationItem[],
  ): BridgeReply {
    const conversationItems = recentConversation.length > 0
      ? recentConversation.map(item => `${item.role === "user" ? "用户" : "助手"}：${item.text}`)
      : ["暂未读取到可展示的最近对话。"];

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前会话",
        summaryLines: [
          "**视图**：当前会话",
          `**项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `**线程**：${thread.threadId}`,
          `**标题**：${thread.title}`,
          `**Session**：${thread.threadId}`,
        ],
        sections: [
          {
            title: "最近对话",
            items: conversationItems,
          },
        ],
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), BRIDGE_COMMAND_PREFIX),
          },
          {
            label: "当前项目",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project current`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
          {
            label: "新会话",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} new`),
          },
        ],
      }),
    };
  }

  private buildCodexThreadSwitchedCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
    thread: CodexCatalogThread,
    recentConversation: CodexCatalogConversationItem[],
  ): BridgeReply {
    const conversationItems = recentConversation.length > 0
      ? recentConversation.map(item => `${item.role === "user" ? "用户" : "助手"}：${item.text}`)
      : ["暂未读取到可展示的最近对话。"];

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "线程已切换",
        summaryLines: [
          "**视图**：线程已切换",
          `**项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `**线程**：${thread.threadId}`,
          `**标题**：${thread.title}`,
          `**Session**：${thread.threadId}`,
        ],
        sections: [
          {
            title: "最近对话",
            items: conversationItems,
          },
          {
            title: "下一步",
            items: [
              `${BRIDGE_COMMAND_PREFIX} thread list-current`,
              `${BRIDGE_COMMAND_PREFIX} project current`,
              "直接发送普通消息，后续内容会进入这个 Codex 线程。",
            ],
          },
        ],
        actions: [
          {
            label: "导航",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), BRIDGE_COMMAND_PREFIX),
          },
          {
            label: "当前项目",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project current`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
          {
            label: "当前会话",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} session`),
          },
        ],
      }),
    };
  }

  private buildCodexProjectUnavailableCardReply(input: BridgeMessageInput): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "项目不可用",
        summaryLines: ["**项目不可用**", "选中的 Codex 项目已不存在或无法读取。"],
        sections: [],
        actions: [
          {
            label: "项目列表",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project list`),
          },
        ],
      }),
    };
  }

  private buildCodexThreadUnavailableCardReply(input: BridgeMessageInput): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "线程不可用",
        summaryLines: ["**线程不可用**", "选中的 Codex 线程已不存在或无法读取。"],
        sections: [],
        actions: [
          {
            label: "项目列表",
            type: "primary",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project list`),
          },
        ],
      }),
    };
  }

  private buildCardActionContext(input: BridgeMessageInput): {
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  } {
    return {
      chatId: input.chatId,
      surfaceType: input.surfaceType,
      surfaceRef: input.surfaceRef,
    };
  }

  private isDmContext(input: BridgeMessageInput): boolean {
    return !input.chatId && input.surfaceType !== "thread";
  }

  private lookupDmCodexSelection(input: BridgeMessageInput): {
    binding: { codexThreadId: string };
    project: CodexCatalogProject;
    thread: CodexCatalogThread;
  } | undefined {
    if (!this.isDmContext(input) || !this.dependencies.codexCatalog) {
      return undefined;
    }

    const binding = this.dependencies.store.getCodexWindowBinding(input.channel, input.peerId);
    if (!binding) {
      return undefined;
    }

    const thread = this.dependencies.codexCatalog.getThread(binding.codexThreadId);
    if (!thread) {
      this.dependencies.store.clearCodexWindowBinding(input.channel, input.peerId);
      return undefined;
    }

    const project = this.dependencies.codexCatalog.getProject(thread.projectKey, {
      includeArchived: true,
    });
    if (!project) {
      this.dependencies.store.clearCodexWindowBinding(input.channel, input.peerId);
      return undefined;
    }

    return {
      binding,
      project,
      thread,
    };
  }

  private isNativeCatalogThread(threadId: string): boolean {
    if (!this.dependencies.codexCatalog) {
      return true;
    }

    return Boolean(this.dependencies.codexCatalog.getThread(threadId));
  }

  private lookupCatalogProjectForSurface(input: BridgeMessageInput): {
    projectId: string;
    project: CodexCatalogProject;
  } | undefined {
    if (!input.chatId || !this.dependencies.codexCatalog) {
      return undefined;
    }

    const projectId = this.dependencies.store.getProjectChatByChatId(input.chatId)?.projectId;
    if (!projectId) {
      return undefined;
    }

    const projectRecord = this.dependencies.store.getProject(projectId);
    if (!projectRecord) {
      return undefined;
    }

    const catalogProject = this.dependencies.codexCatalog
      .listProjects({ includeArchived: true })
      .find(project => normalizePathKey(project.cwd) === normalizePathKey(projectRecord.cwd));

    if (!catalogProject) {
      return undefined;
    }

    return {
      projectId,
      project: catalogProject,
    };
  }

  private async materializeNativeContext(
    input: BridgeMessageInput,
    resolved: ResolvedContext,
    prompt: string,
  ): Promise<ResolvedContext> {
    if (resolved.context.targetKind !== "new_codex_thread") {
      return resolved;
    }

    const created = await this.dependencies.runner.createThread({
      cwd: resolved.context.cwd,
      prompt: buildNativeThreadBootstrapPrompt(resolved.context.threadTitle ?? prompt),
    });

    if (input.surfaceType === "thread" && input.chatId && input.surfaceRef) {
      this.dependencies.store.rebindCodexThreadSurface({
        chatId: input.chatId,
        feishuThreadId: input.surfaceRef,
        threadId: created.threadId,
        sessionName: created.threadId,
        title: resolved.context.threadTitle ?? created.threadId,
        status: "warm",
      });
    } else {
      this.dependencies.store.bindCodexWindow({
        channel: input.channel,
        peerId: input.peerId,
        codexThreadId: created.threadId,
      });
    }

    return {
      ...resolved,
      sessionName: created.threadId,
      threadId: created.threadId,
      concurrencyKey: `codex-thread:${created.threadId}`,
      context: {
        targetKind: "codex_thread",
        threadId: created.threadId,
        sessionName: created.threadId,
        cwd: resolved.context.cwd,
      },
    };
  }

  private buildCardActionValue(
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
    command: string,
  ): Record<string, unknown> {
    return {
      command,
      chatId: context.chatId,
      surfaceType: context.surfaceType,
      surfaceRef: context.surfaceRef,
    };
  }

  private buildPlanActionValue(
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
  ): Record<string, unknown> {
    return {
      bridgeAction: "open_plan_form",
      chatId: context.chatId,
      surfaceType: context.surfaceType,
      surfaceRef: context.surfaceRef,
    };
  }
}

function buildSessionName(rootId: string): string {
  return `codex-${rootId}`;
}

function buildRunId(): string {
  return `run-${randomUUID()}`;
}

function selectSwitchCardConversation(
  items: CodexCatalogConversationItem[],
): CodexCatalogConversationItem[] {
  const latestUser = [...items].reverse().find(item => item.role === "user");
  const latestAssistants = items.filter(item => item.role === "assistant").slice(-4);

  return items.filter(item => item === latestUser || latestAssistants.includes(item));
}

function buildNativeThreadBootstrapPrompt(topic: string): string {
  return [
    "Initialize a Codex thread for subsequent Feishu bridge messages.",
    "Keep the response minimal.",
    `Topic: ${topic}`,
  ].join("\n");
}

function matchesPlanInteractionSurface(
  interaction: PendingPlanInteractionRecord,
  input: {
    channel: string;
    peerId: string;
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  },
): boolean {
  return (
    interaction.channel === input.channel &&
    interaction.peerId === input.peerId &&
    (interaction.chatId ?? null) === (input.chatId ?? null) &&
    (interaction.surfaceType ?? null) === (input.surfaceType ?? null) &&
    (interaction.surfaceRef ?? null) === (input.surfaceRef ?? null)
  );
}

function normalizePathKey(value: string): string {
  return value
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function findFinalAssistantText(events: AcpxEvent[]): string {
  const finalText = [...events]
    .reverse()
    .find(event => (event.type === "done" || event.type === "text") && event.content);

  if (!finalText || !finalText.content) {
  return "[ca] run completed with no assistant output";
  }

  return finalText.content;
}

function isTerminalProgress(progress: ProgressCardState): boolean {
  return progress.status === "done" || progress.status === "error" || progress.status === "canceled";
}

function normalizeRunError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "RUN_STREAM_FAILED";
}

function extractErrorText(preview: string): string {
  const prefix = "[ca] error: ";
  return preview.startsWith(prefix) ? preview.slice(prefix.length) : preview;
}

function buildCodexPromptEnvelope(root: RootProfile, prompt: string): string {
  return [
    "[bridge-context]",
    `root_name: ${root.id}`,
    `root_path: ${root.cwd}`,
    "instructions:",
    "- You are operating inside the configured bridge root.",
    "- Discover projects and repositories under this root yourself.",
    "- If the user asks about available projects, inspect the filesystem and answer directly.",
    `- Do not tell the user to use ${BRIDGE_COMMAND_PREFIX} repo commands because bridge does not manage projects.`,
    "[/bridge-context]",
    "",
    "[user-message]",
    prompt,
    "[/user-message]",
  ].join("\n");
}
