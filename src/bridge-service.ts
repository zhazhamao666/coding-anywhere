import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  DEFAULT_BRIDGE_ASSET_ROOT_DIR,
  parseBridgeImageDirective,
  validateBridgeImagePath,
} from "./bridge-image-directive.js";
import { BRIDGE_COMMAND_PREFIX, routeBridgeInput } from "./command-router.js";
import { normalizeReasoningEffort } from "./codex-preferences.js";
import { parseCodexThreadSourceInfo } from "./codex-thread-source.js";
import { buildBridgeHubCard } from "./feishu-card/navigation-card-builder.js";
import { normalizeMarkdownToPlainText } from "./markdown-text.js";
import type { ProjectThreadService } from "./project-thread-service.js";
import { createProgressCardState, reduceProgressEvent } from "./progress-relay.js";
import { isRunCanceledError } from "./run-cancel-error.js";
import type { RunControl, RunDescriptor } from "./run-worker-manager.js";
import type {
  BridgeAssetRecord,
  BridgeMessageInput,
  BridgeLifecycleStage,
  BridgeReply,
  CodexCatalogConversationItem,
  CodexCatalogProject,
  CodexPreferenceCatalog,
  CodexPreferenceRecord,
  CodexReasoningEffort,
  CodexCatalogThread,
  CodexCatalogThreadSourceInfo,
  PendingPlanInteractionRecord,
  RootProfile,
  ProgressCardState,
  RuntimeRunSnapshot,
  RunContext,
  RunOutcome,
  RunnerEvent,
} from "./types.js";
import { SessionStore } from "./workspace/session-store.js";

interface BridgeRunner {
  createThread(
    input: {
      cwd: string;
      prompt: string;
      images?: string[];
      sessionName?: string;
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
    },
    onEvent?: (event: RunnerEvent) => void,
  ): Promise<RunOutcome & { threadId: string }>;
  ensureSession(context: RunContext): Promise<void>;
  submitVerbatim(
    context: RunContext,
    prompt: string,
    optionsOrOnEvent?: {
      images?: string[];
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
    } | ((event: RunnerEvent) => void | Promise<void>),
    onEvent?: (event: RunnerEvent) => void,
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
  schedule<T>(descriptor: RunDescriptor, worker: (control: RunControl) => Promise<T>): Promise<T>;
  updateRunProgress(runId: string, input: {
    status: ProgressCardState["status"];
    stage: ProgressCardState["stage"];
    latestPreview: string;
    latestTool?: string | null;
  }): void;
  rebindRun(runId: string, input: {
    concurrencyKey?: string;
    projectId?: string | null;
    threadId?: string | null;
    deliveryChatId?: string | null;
    deliverySurfaceType?: "thread" | null;
    deliverySurfaceRef?: string | null;
    sessionName?: string;
  }): void;
  getCurrentRun(concurrencyKey: string): RuntimeRunSnapshot | undefined;
  cancelRun(runId: string, options?: {
    requestedBy?: string | null;
    source?: "feishu" | "ops";
  }): Promise<{
    accepted: boolean;
    runId: string;
    newStatus: ProgressCardState["status"];
    message: string;
  }>;
}

interface CodexCatalogLike {
  listProjects(options?: { includeArchived?: boolean }): CodexCatalogProject[];
  getProject(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogProject | undefined;
  listThreads(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogThread[];
  getThread(threadId: string): CodexCatalogThread | undefined;
  listRecentConversation(threadId: string, limit?: number): CodexCatalogConversationItem[];
}

interface CatalogProjectChatBinding {
  projectId: string;
  cwd: string;
  chatId: string | null;
}

interface CodexPreferenceTarget {
  kind: "thread" | "surface";
  threadId?: string;
  surface: {
    channel: string;
    peerId: string;
    chatId?: string | null;
    surfaceType?: "thread" | null;
    surfaceRef?: string | null;
  };
}

interface EffectiveCodexPreferences {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  source: "thread" | "surface" | "default";
}

export class BridgeService {
  public constructor(
    private readonly dependencies: {
      store: SessionStore;
      runner: BridgeRunner;
      managedAssetRootDir?: string;
      workerManager?: RunWorkerManagerLike;
      projectThreadService?: Pick<ProjectThreadService, "createThread" | "linkThread">;
      codexCatalog?: CodexCatalogLike;
      codexPreferences?: CodexPreferenceCatalog;
    },
  ) {}

  public async handleMessage(input: BridgeMessageInput, options?: {
    onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
  }): Promise<BridgeReply[]> {
    const routed = routeBridgeInput(input.text);

    if (routed.kind === "command") {
      return this.handleCommand(input, routed.command.name, routed.command.args);
    }

    const stagedAssets = this.dependencies.store.listPendingBridgeAssetsForSurface({
      channel: input.channel,
      peerId: input.peerId,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
    });

    const resolved = this.resolveContext(input);
    const effectivePreferences = this.resolveEffectiveCodexPreferences(input, resolved);
    let currentProgress = createProgressCardState({
      runId: buildRunId(),
      rootName: resolved.root.id,
      sessionName: resolved.sessionName,
      model: effectivePreferences.model,
      reasoningEffort: effectivePreferences.reasoningEffort,
      deliveryChatId: resolved.deliveryChatId,
      deliverySurfaceType: resolved.deliverySurfaceType,
      deliverySurfaceRef: resolved.deliverySurfaceRef,
    });
    const startedAtIso = new Date(currentProgress.startedAt).toISOString();

    const emitSnapshot = async (
      snapshot: ProgressCardState,
      source: "bridge" | "runner" | "system",
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
      this.dependencies.workerManager?.updateRunProgress(currentProgress.runId, {
        status: currentProgress.status,
        stage: currentProgress.stage,
        latestPreview: currentProgress.preview,
        latestTool: toolName ?? currentProgress.latestTool ?? null,
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

    this.dependencies.store.createRun({
      runId: currentProgress.runId,
      channel: input.channel,
      peerId: input.peerId,
      projectId: resolved.projectId,
      threadId: resolved.threadId,
      deliveryChatId: resolved.deliveryChatId,
      deliverySurfaceType: resolved.deliverySurfaceType,
      deliverySurfaceRef: resolved.deliverySurfaceRef,
      sessionName: resolved.sessionName,
      rootId: resolved.root.id,
      status: currentProgress.status,
      stage: currentProgress.stage,
      latestPreview: currentProgress.preview,
      startedAt: startedAtIso,
      updatedAt: startedAtIso,
    });

    await emitLifecycle("received", "[ca] received", resolved.sessionName);
    let currentThreadId = resolved.threadId;

    const executeRun = async (control?: RunControl): Promise<BridgeReply[]> => {
      let activeResolved = resolved;
      let consumedAssets: BridgeAssetRecord[] = [];
      let sawRunnerEvent = false;

      if (activeResolved.context.targetKind === "new_codex_thread") {
        activeResolved = await this.materializeNativeContext(
          input,
          activeResolved,
          routed.prompt,
          effectivePreferences,
        );
        currentThreadId = activeResolved.threadId;
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
        this.dependencies.workerManager?.rebindRun(currentProgress.runId, {
          concurrencyKey: activeResolved.concurrencyKey,
          projectId: activeResolved.projectId,
          threadId: activeResolved.threadId,
          deliveryChatId: activeResolved.deliveryChatId,
          deliverySurfaceType: activeResolved.deliverySurfaceType,
          deliverySurfaceRef: activeResolved.deliverySurfaceRef,
          sessionName: activeResolved.sessionName,
        });
      }

      if (activeResolved.threadId) {
        this.dependencies.store.updateCodexThreadState({
          threadId: activeResolved.threadId,
          status: "running",
          lastRunId: currentProgress.runId,
        });
      }

      control?.setOnCancelRequested(async cancelRequest => {
        this.dependencies.store.markRunCancelRequested({
          runId: currentProgress.runId,
          requestedBy: cancelRequest.requestedBy ?? null,
          source: cancelRequest.source ?? "ops",
          requestedAt: cancelRequest.requestedAt,
        });
        const cancelingSnapshot: ProgressCardState = {
          ...currentProgress,
          status: "canceling",
          stage: "canceling",
          preview: "[ca] cancel requested",
          elapsedMs: Date.now() - currentProgress.startedAt,
        };
        await emitSnapshot(cancelingSnapshot, "system");
      });

      await emitLifecycle("resolving_context", "[ca] resolving context", activeResolved.sessionName);
      await emitLifecycle("ensuring_session", "[ca] ensuring session", activeResolved.sessionName);
      await this.dependencies.runner.ensureSession(activeResolved.context);
      await emitLifecycle(
        "session_ready",
        `[ca] session ready: ${activeResolved.sessionName}`,
        activeResolved.sessionName,
      );
      consumedAssets = stagedAssets.length > 0
        ? this.dependencies.store.consumePendingBridgeAssets({
            runId: currentProgress.runId,
            assetIds: stagedAssets.map(asset => asset.assetId),
          })
        : [];
      const promptText = buildPromptForCodexRun({
        root: activeResolved.root,
        prompt: routed.prompt,
        wrapPrompt: activeResolved.wrapPrompt,
        assets: consumedAssets,
      });
      await emitLifecycle("submitting_prompt", "[ca] submitting prompt", activeResolved.sessionName);
      await emitLifecycle(
        "waiting_first_event",
        "[ca] waiting for Codex response",
        activeResolved.sessionName,
      );

      const runnerEventHandler = async (event: RunnerEvent) => {
        sawRunnerEvent = true;
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
          "runner",
          event.type === "tool_call" ? event.toolName : undefined,
          event.type === "text" || event.type === "waiting",
        );
      };

      let outcome: RunOutcome;
      try {
        const imagePaths = consumedAssets
          .filter(asset => asset.resourceType === "image")
          .map(asset => asset.localPath);
        control?.setCanceler(async () => {
          await this.dependencies.runner.cancel(activeResolved.context);
        });
        if (imagePaths.length > 0 || effectivePreferences.source !== "default") {
          const runnerOptions: {
            images?: string[];
            model?: string;
            reasoningEffort?: CodexReasoningEffort;
          } = {};
          if (imagePaths.length > 0) {
            runnerOptions.images = imagePaths;
          }
          if (effectivePreferences.source !== "default") {
            runnerOptions.model = effectivePreferences.model;
            runnerOptions.reasoningEffort = effectivePreferences.reasoningEffort;
          }
          outcome = await this.dependencies.runner.submitVerbatim(
            activeResolved.context,
            promptText,
            runnerOptions,
            runnerEventHandler,
          );
        } else {
          outcome = await this.dependencies.runner.submitVerbatim(
            activeResolved.context,
            promptText,
            runnerEventHandler,
          );
        }
      } catch (error) {
        if (!sawRunnerEvent && consumedAssets.length > 0) {
          this.dependencies.store.restoreConsumedBridgeAssets({
            runId: currentProgress.runId,
            assetIds: consumedAssets.map(asset => asset.assetId),
          });
        }
        throw error;
      }

      const finalText = findFinalAssistantText(outcome.events);
      const finalOutput = buildFinalBridgeReplies({
        finalText,
        cwd: activeResolved.context.cwd,
        managedAssetRootDir: this.dependencies.managedAssetRootDir ?? DEFAULT_BRIDGE_ASSET_ROOT_DIR,
      });

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
          content: finalOutput.previewText,
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

      return finalOutput.replies;
    };

    const executeWithErrorHandling = async (control?: RunControl): Promise<BridgeReply[]> => {
      try {
        return await executeRun(control);
      } catch (error) {
        if (isRunCanceledError(error)) {
          const canceledSnapshot: ProgressCardState = {
            ...currentProgress,
            status: "canceled",
            stage: "canceled",
            preview: "[ca] run canceled",
            elapsedMs: Date.now() - currentProgress.startedAt,
          };
          await emitSnapshot(canceledSnapshot, "system");
          this.dependencies.store.completeRun({
            runId: currentProgress.runId,
            status: "canceled",
            stage: "canceled",
            latestPreview: canceledSnapshot.preview,
            latestTool: canceledSnapshot.latestTool ?? null,
          });

          if (currentThreadId) {
            this.dependencies.store.updateCodexThreadState({
              threadId: currentThreadId,
              status: "warm",
              lastRunId: currentProgress.runId,
            });
          }

          return [{
            kind: "system",
            text: "[ca] run canceled",
          }];
        }

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

        if (currentThreadId) {
          this.dependencies.store.updateCodexThreadState({
            threadId: currentThreadId,
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

    const runDescriptor: RunDescriptor = {
      runId: currentProgress.runId,
      concurrencyKey: resolved.concurrencyKey,
      channel: input.channel,
      peerId: input.peerId,
      projectId: resolved.projectId,
      threadId: resolved.threadId,
      deliveryChatId: resolved.deliveryChatId,
      deliverySurfaceType: resolved.deliverySurfaceType,
      deliverySurfaceRef: resolved.deliverySurfaceRef,
      sessionName: resolved.sessionName,
      rootId: resolved.root.id,
      model: effectivePreferences.model,
      reasoningEffort: effectivePreferences.reasoningEffort,
      status: currentProgress.status,
      stage: currentProgress.stage,
      latestPreview: currentProgress.preview,
      startedAt: startedAtIso,
    };

    try {
      return await this.dependencies.workerManager.schedule(runDescriptor, executeWithErrorHandling);
    } catch (error) {
      if (isRunCanceledError(error)) {
        const canceledSnapshot: ProgressCardState = {
          ...currentProgress,
          status: "canceled",
          stage: "canceled",
          preview: "[ca] run canceled",
          elapsedMs: Date.now() - currentProgress.startedAt,
        };
        await emitSnapshot(canceledSnapshot, "system");
        this.dependencies.store.completeRun({
          runId: currentProgress.runId,
          status: "canceled",
          stage: "canceled",
          latestPreview: canceledSnapshot.preview,
          latestTool: canceledSnapshot.latestTool ?? null,
        });
        return [{
          kind: "system",
          text: "[ca] run canceled",
        }];
      }

      throw error;
    }
  }

  public getPendingPlanInteraction(interactionId: string): PendingPlanInteractionRecord | undefined {
    return this.dependencies.store.getPendingPlanInteraction(interactionId);
  }

  public async updateCodexPreferences(input: {
    channel: string;
    peerId: string;
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
  }): Promise<BridgeReply> {
    const sessionInput: BridgeMessageInput = {
      channel: input.channel,
      peerId: input.peerId,
      chatId: input.chatId,
      surfaceType: input.surfaceType,
      surfaceRef: input.surfaceRef,
      text: `${BRIDGE_COMMAND_PREFIX} session`,
    };
    const resolved = this.resolveContext(sessionInput);
    const target = this.resolveCodexPreferenceTarget(sessionInput, resolved);
    const effectivePreferences = this.resolveEffectiveCodexPreferences(sessionInput, resolved);
    const nextModel = normalizeCodexModel(input.model) ?? effectivePreferences.model;
    const nextReasoningEffort = normalizeReasoningEffort(input.reasoningEffort) ?? effectivePreferences.reasoningEffort;

    if (target.kind === "thread" && target.threadId) {
      this.dependencies.store.upsertCodexThreadPreference({
        threadId: target.threadId,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
      });
    } else {
      this.dependencies.store.upsertCodexSurfacePreference({
        ...target.surface,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
      });
    }

    const [reply] = await this.handleMessage(sessionInput);
    return reply ?? {
      kind: "system",
      text: "[ca] codex preferences updated",
    };
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
        const resolved = this.tryResolveContext(input);
        const currentRun = this.findCurrentRunForResolved(resolved);
        return [this.buildRunStatusCardReply(input, resolved, currentRun)];
      }
      case "new": {
        const resolved = this.resolveContext(input);
        const effectivePreferences = this.resolveEffectiveCodexPreferences(input, resolved);
        const currentThread = input.surfaceType === "thread" && input.chatId && input.surfaceRef
          ? this.dependencies.store.getCodexThreadBySurface(input.chatId, input.surfaceRef)
          : undefined;
        const createThreadInput: {
          cwd: string;
          prompt: string;
          model?: string;
          reasoningEffort?: CodexReasoningEffort;
        } = {
          cwd: resolved.context.cwd,
          prompt: buildNativeThreadBootstrapPrompt(currentThread?.title ?? resolved.threadId ?? resolved.sessionName),
        };
        if (effectivePreferences.source !== "default") {
          createThreadInput.model = effectivePreferences.model;
          createThreadInput.reasoningEffort = effectivePreferences.reasoningEffort;
        }
        const created = await this.dependencies.runner.createThread(createThreadInput);
        this.dependencies.store.upsertCodexThreadPreference({
          threadId: created.threadId,
          model: effectivePreferences.model,
          reasoningEffort: effectivePreferences.reasoningEffort,
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
        const resolved = this.tryResolveContext(input);
        if (!resolved || !this.dependencies.workerManager) {
          return [{ kind: "system", text: "[ca] current run not found" }];
        }

        const currentRun = this.findCurrentRunForResolved(resolved);
        if (!currentRun) {
          return [{ kind: "system", text: "[ca] current run not found" }];
        }
        if (currentRun.status === "queued") {
          this.dependencies.store.markRunCancelRequested({
            runId: currentRun.runId,
            requestedBy: input.peerId,
            source: "feishu",
          });
          this.dependencies.store.appendRunEvent({
            runId: currentRun.runId,
            source: "system",
            status: "canceling",
            stage: "canceling",
            preview: "[ca] cancel requested",
          });
        }

        const result = await this.dependencies.workerManager.cancelRun(currentRun.runId, {
          requestedBy: input.peerId,
          source: "feishu",
        });
        if (!result.accepted) {
          return [{ kind: "system", text: "[ca] current run already finished" }];
        }

        return [{
          kind: "system",
          text: result.newStatus === "canceled"
            ? "[ca] current run canceled"
            : "[ca] stop requested for current run",
        }];
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
        return [this.buildResolvedSessionCardReply(input, resolved)];
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
    const resolved = this.tryResolveContext(input);
    const effectivePreferences = resolved
      ? this.resolveEffectiveCodexPreferences(input, resolved)
      : undefined;
    if (effectivePreferences) {
      summaryLines.push(...this.buildCodexPreferenceSummaryLines(effectivePreferences));
    }
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

      const currentRun = this.findCurrentRunByThreadId(thread.threadId);

      summaryLines.push(`**当前项目**：${project.name}`);
      summaryLines.push(`**当前线程**：${formatCurrentThreadLabel(thread.title, thread.threadId)}`);
      summaryLines.push(`线程 ID：${thread.threadId}`);
      summaryLines.push(`**线程状态**：${thread.status ?? "provisioned"}`);
      if (currentRun) {
        sections.push({
          title: "当前运行",
          items: this.buildCurrentRunItems(currentRun),
        });
      }
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
            label: "运行状态",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} status`),
          },
          {
            label: "新会话",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} new`),
          },
        );
      this.maybePushStopAction(actions, actionContext, currentRun);
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
        const currentRun = this.findCurrentRunByThreadId(codexSelection.thread.threadId, `codex-thread:${codexSelection.thread.threadId}`);
        summaryLines.push(`**当前项目**：${codexSelection.project.displayName}`);
        summaryLines.push(`**项目路径**：${codexSelection.project.cwd}`);
        summaryLines.push(
          `**当前线程**：${formatCurrentThreadLabel(
            codexSelection.thread.title,
            codexSelection.thread.threadId,
          )}`,
        );
        summaryLines.push(`线程 ID：${codexSelection.thread.threadId}`);
        if (currentRun) {
          sections.push({
            title: "当前运行",
            items: this.buildCurrentRunItems(currentRun),
          });
        }
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
            label: "运行状态",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} status`),
          },
          {
            label: "新会话",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} new`),
          },
        );
        this.maybePushStopAction(actions, actionContext, currentRun);
      } else {
        const resolved = this.tryResolveContext(input);
        const currentRun = this.findCurrentRunForResolved(resolved);
        const selectedProject = this.lookupDmSelectedProject(input);

        summaryLines.push(`**当前上下文**：${selectedProject ? "已选择项目，未绑定线程" : "未选择项目和线程"}`);
        if (selectedProject) {
          summaryLines.push(`**已选项目**：${selectedProject.displayName}`);
          summaryLines.push(`**项目路径**：${selectedProject.cwd}`);
        }
        if (currentRun) {
          sections.push({
            title: "当前运行",
            items: this.buildCurrentRunItems(currentRun),
          });
        }
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
              label: "运行状态",
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
        this.maybePushStopAction(actions, actionContext, currentRun);
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
      `[ca] project commands: ${BRIDGE_COMMAND_PREFIX} project bind <projectId> <chatId> <cwd> [name], ${BRIDGE_COMMAND_PREFIX} project bind-current <projectId> <cwd> [name], ${BRIDGE_COMMAND_PREFIX} project bind-current <projectKey>, ${BRIDGE_COMMAND_PREFIX} project current, ${BRIDGE_COMMAND_PREFIX} project list, ${BRIDGE_COMMAND_PREFIX} project switch <projectKey>`;

    if (action === "list") {
      if (this.isDmContext(input) && this.dependencies.codexCatalog) {
        const projects = this.dependencies.codexCatalog.listProjects();
        return [this.buildCodexProjectListCardReply(input, projects)];
      }
      if (input.chatId && this.dependencies.codexCatalog) {
        const projects = this.dependencies.codexCatalog.listProjects();
        return [this.buildGroupCodexProjectListCardReply(input, projects)];
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

    if (action === "switch" && this.isDmContext(input) && this.dependencies.codexCatalog) {
      if (!rawProjectId) {
        return [{ kind: "system", text: projectCommandHelp }];
      }

      const project = this.dependencies.codexCatalog.getProject(rawProjectId, {
        includeArchived: true,
      });
      if (!project) {
        return [this.buildCodexProjectUnavailableCardReply(input)];
      }

      const hadBoundThread = Boolean(this.dependencies.store.getCodexWindowBinding(input.channel, input.peerId));
      this.dependencies.store.setCodexProjectSelection({
        channel: input.channel,
        peerId: input.peerId,
        projectKey: project.projectKey,
      });
      if (hadBoundThread) {
        this.dependencies.store.clearCodexWindowBinding(input.channel, input.peerId);
      }

      return [this.buildCodexProjectSwitchedCardReply(input, project, hadBoundThread)];
    }

    if (action === "current") {
      if (this.isDmContext(input) && this.dependencies.codexCatalog) {
        const codexSelection = this.lookupDmCodexSelection(input);
        if (codexSelection) {
          return [this.buildCurrentCodexProjectCardReply(input, codexSelection.project, codexSelection.thread)];
        }

        const selectedProject = this.lookupDmSelectedProject(input);
        if (!selectedProject) {
          return [{ kind: "system", text: "[ca] current project: none" }];
        }

        return [this.buildSelectedCodexProjectCardReply(input, selectedProject)];
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
    if (isBindCurrent && rawProjectId && !rawChatIdOrCwd && this.dependencies.codexCatalog) {
      return [this.bindCurrentGroupToCatalogProject(input, rawProjectId)];
    }

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
    const existingTargetChat = this.dependencies.store.getProjectChat(projectId);
    if (isBindCurrent && existingTargetChat?.chatId && existingTargetChat.chatId !== chatId) {
      return [this.buildProjectAlreadyBoundToOtherGroupCardReply({
        projectName: name,
        projectId,
        cwd: resolvedCwd,
        currentChatId: chatId,
        boundChatId: existingTargetChat.chatId,
      })];
    }

    this.dependencies.store.createProject({
      projectId,
      name,
      cwd: resolvedCwd,
      repoRoot: resolvedCwd,
    });
    if (isBindCurrent) {
      this.dependencies.store.clearProjectChatByChatId(chatId);
    }
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
        this.dependencies.store.setCodexProjectSelection({
          channel: input.channel,
          peerId: input.peerId,
          projectKey: thread.projectKey,
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
          if (codexSelection) {
            const threads = this.dependencies.codexCatalog.listThreads(codexSelection.project.projectKey);
            return [this.buildCodexThreadListCardReply(input, codexSelection.project, threads)];
          }

          const selectedProject = this.lookupDmSelectedProject(input);
          if (!selectedProject) {
            return [{ kind: "system", text: threadCommandHelp }];
          }

          const threads = this.dependencies.codexCatalog.listThreads(selectedProject.projectKey);
          return [this.buildCodexThreadListCardReply(input, selectedProject, threads)];
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

    if (input.chatId) {
      const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
      if (projectChat) {
        const project = this.dependencies.store.getProject(projectChat.projectId);
        if (!project) {
          throw new Error("PROJECT_NOT_REGISTERED");
        }

        return {
          root,
          wrapPrompt: true,
          sessionName: buildSessionName(root.id),
          projectId: project.projectId,
          threadId: null,
          deliveryChatId: input.chatId,
          deliverySurfaceType: null,
          deliverySurfaceRef: null,
          concurrencyKey: `pending-project-chat:${input.chatId}`,
          context: {
            targetKind: "new_codex_thread",
            sessionName: buildSessionName(root.id),
            cwd: project.cwd,
          },
        };
      }
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

    const selectedProject = this.lookupDmSelectedProject(input);
    if (selectedProject) {
      return {
        root,
        wrapPrompt: true,
        sessionName: buildSessionName(root.id),
        projectId: selectedProject.projectKey,
        threadId: null,
        deliveryChatId: null,
        deliverySurfaceType: null,
        deliverySurfaceRef: null,
        concurrencyKey: `pending-codex-thread:${input.channel}:${input.peerId}`,
        context: {
          targetKind: "new_codex_thread",
          sessionName: buildSessionName(root.id),
          cwd: selectedProject.cwd,
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

  private bindCurrentGroupToCatalogProject(
    input: BridgeMessageInput,
    projectKey: string,
  ): BridgeReply {
    if (!input.chatId) {
      throw new Error("PROJECT_CHAT_CONTEXT_REQUIRED");
    }
    if (!this.dependencies.codexCatalog) {
      throw new Error("CODEX_CATALOG_NOT_CONFIGURED");
    }

    const project = this.dependencies.codexCatalog.getProject(projectKey, {
      includeArchived: true,
    });
    if (!project) {
      return this.buildCodexProjectUnavailableCardReply(input);
    }

    const bindings = this.listCatalogProjectChatBindings();
    const binding = lookupCatalogProjectChatBinding(project, bindings, input.chatId);
    if (binding.state === "other") {
      return this.buildProjectAlreadyBoundToOtherGroupCardReply({
        projectName: project.displayName,
        projectId: project.projectKey,
        cwd: project.cwd,
        currentChatId: input.chatId,
        boundChatId: binding.chatId,
      });
    }

    this.dependencies.store.createProject({
      projectId: project.projectKey,
      name: project.displayName,
      cwd: project.cwd,
      repoRoot: project.cwd,
    });
    this.dependencies.store.clearProjectChatByChatId(input.chatId);
    this.dependencies.store.upsertProjectChat({
      projectId: project.projectKey,
      chatId: input.chatId,
      groupMessageType: "thread",
      title: `Codex | ${project.displayName}`,
    });

    return this.buildCatalogProjectBoundCardReply(input, project);
  }

  private buildCatalogProjectBoundCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
  ): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "项目已绑定",
        summaryLines: [
          "**视图**：项目已绑定",
          `**项目**：${project.displayName}`,
          `**群聊**：${input.chatId ?? "unknown"}`,
          `**路径**：${project.cwd}`,
        ],
        sections: [
          {
            title: "下一步",
            items: [
              `在本群发送 \`${BRIDGE_COMMAND_PREFIX} thread create-current <标题>\` 创建飞书话题。`,
              "之后在新话题里发送普通消息，Codex 会在该项目上下文中执行。",
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
            label: "新会话",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} new`),
          },
        ],
      }),
    };
  }

  private buildProjectAlreadyBoundToOtherGroupCardReply(input: {
    projectName: string;
    projectId: string;
    cwd: string;
    currentChatId: string;
    boundChatId: string;
  }): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "项目已绑定其他群",
        summaryLines: [
          "**视图**：项目已绑定其他群",
          `**项目**：${input.projectName}`,
          `**项目 ID**：${input.projectId}`,
          `**已绑定群**：${input.boundChatId}`,
          `**当前群**：${input.currentChatId}`,
          `**路径**：${input.cwd}`,
        ],
        sections: [
          {
            title: "未执行绑定",
            items: ["为避免误伤其它群，本次不会把该项目从原群转绑到当前群。"],
          },
        ],
      }),
    };
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

  private buildGroupCodexProjectListCardReply(
    input: BridgeMessageInput,
    projects: CodexCatalogProject[],
  ): BridgeReply {
    const bindings = this.listCatalogProjectChatBindings();
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "项目列表",
        summaryLines: [
          "**视图**：Codex 项目列表",
          `**项目数**：${projects.length}`,
          `**当前群**：${input.chatId ?? "unknown"}`,
        ],
        sections: projects.length > 0
          ? []
          : [
              {
                title: "暂无可浏览项目",
                items: ["当前 Codex 线程库中没有可用项目。"],
              },
            ],
        rows: projects.map(project => {
          const binding = lookupCatalogProjectChatBinding(project, bindings, input.chatId ?? null);
          const buttons = buildGroupProjectButtons({
            bindingState: binding.state,
            currentChatId: input.chatId,
            currentProjectValue: this.buildCardActionValue(
              this.buildCardActionContext(input),
              `${BRIDGE_COMMAND_PREFIX} project current`,
            ),
            bindValue: this.buildCardActionValue(
              this.buildCardActionContext(input),
              `${BRIDGE_COMMAND_PREFIX} project bind-current ${project.projectKey}`,
            ),
          });

          return {
            title: project.displayName,
            lines: [
              `路径：${project.cwd}`,
              `线程：${project.activeThreadCount}/${project.threadCount}`,
              `最近更新：${project.lastUpdatedAt}`,
              `绑定：${formatGroupProjectBinding(binding)}`,
            ],
            buttons,
          };
        }),
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
          ...(input.chatId
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
          `**当前项目**：${input.projectId}`,
          `**当前线程**：${formatCurrentThreadLabel(input.title, input.threadId)}`,
          `线程 ID：${input.threadId}`,
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
          {
            label: "新会话",
            value: this.buildCardActionValue({ chatId: input.chatId }, `${BRIDGE_COMMAND_PREFIX} new`),
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
          buttons: [
            {
              label: "查看线程",
              value: this.buildCardActionValue(
                this.buildCardActionContext(input),
                `${BRIDGE_COMMAND_PREFIX} project threads ${project.projectKey}`,
              ),
            },
            {
              label: "切换项目",
              type: "primary",
              value: this.buildCardActionValue(
                this.buildCardActionContext(input),
                `${BRIDGE_COMMAND_PREFIX} project switch ${project.projectKey}`,
              ),
            },
          ],
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
          {
            label: "新会话",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} new`),
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
    const displayThreads = orderCodexThreadsForParentChildDisplay(threads);
    const threadById = new Map(threads.map(thread => [thread.threadId, thread]));
    const subagentCount = threads.filter(thread => getCodexThreadSourceInfo(thread).kind === "subagent").length;
    const parentAgentCount = threads.length - subagentCount;

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "线程列表",
        summaryLines: [
          "**视图**：Codex 线程列表",
          `**当前项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `线程数：${threads.length} · 母 agent：${parentAgentCount} · 子 agent：${subagentCount}`,
        ],
        sections: threads.length > 0
          ? []
          : [
              {
                title: "暂无线程",
                items: ["当前项目下没有可切换的 Codex 线程。"],
              },
            ],
        rows: displayThreads.map(thread => ({
          title: formatCodexThreadListTitle(thread),
          lines: formatCodexThreadListLines(thread, threadById),
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
          {
            label: "新会话",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} new`),
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
          `**当前线程**：${formatCurrentThreadLabel(thread.title, thread.threadId)}`,
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

  private buildSelectedCodexProjectCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
  ): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前项目",
        summaryLines: [
          "**视图**：当前项目",
          `**项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          "**当前线程**：未选择",
        ],
        sections: [
          {
            title: "下一步",
            items: [
              "可以先查看这个项目的线程列表。",
              "也可以直接发送普通消息，在该项目下创建新的 native Codex thread。",
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
            label: "项目列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} project list`),
          },
          {
            label: "线程列表",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
          {
            label: "运行状态",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} status`),
          },
          {
            label: "新会话",
            value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} new`),
          },
        ],
      }),
    };
  }

  private buildCodexProjectSwitchedCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
    clearedPreviousThread = false,
  ): BridgeReply {
    const nextStepItems = [
      `当前项目：${project.displayName}`,
      ...(clearedPreviousThread ? ["已退出之前绑定的线程，避免继续误跑旧项目。"] : []),
      "下一条普通消息会在该项目下创建新会话。",
    ];

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前项目已切换",
        summaryLines: [
          "**视图**：当前项目已切换",
          `**项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
        ],
        sections: [
          {
            title: "下一步",
            items: nextStepItems,
          },
        ],
        actions: [
          {
            label: "当前项目",
            type: "primary",
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

  private buildCurrentCodexSessionCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
    thread: CodexCatalogThread,
    recentConversation: CodexCatalogConversationItem[],
  ): BridgeReply {
    const resolved = this.resolveContext(input);
    const effectivePreferences = this.resolveEffectiveCodexPreferences(input, resolved);
    const currentRun = this.findCurrentRunByThreadId(thread.threadId, `codex-thread:${thread.threadId}`);
    const actionContext = this.buildCardActionContext(input);
    const conversationItems = recentConversation.length > 0
      ? recentConversation.map(item => `${item.role === "user" ? "用户" : "助手"}：${item.text}`)
      : ["暂未读取到可展示的最近对话。"];

    const sections: Array<{
      title: string;
      items: string[];
      monospace?: boolean;
    }> = [];
    if (currentRun) {
      sections.push({
        title: "当前运行",
        items: this.buildCurrentRunItems(currentRun),
      });
    }
    sections.push({
      title: "最近对话",
      items: conversationItems,
    });
    const actions: Array<{
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }> = [
      {
        label: "导航",
        type: "primary",
        value: this.buildCardActionValue(actionContext, BRIDGE_COMMAND_PREFIX),
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
        label: "运行状态",
        value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} status`),
      },
      {
        label: "新会话",
        value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} new`),
      },
    ];
    this.maybePushStopAction(actions, actionContext, currentRun);

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前会话",
        summaryLines: [
          "**视图**：当前会话",
          `**当前项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `**当前线程**：${formatCurrentThreadLabel(thread.title, thread.threadId)}`,
          `线程 ID：${thread.threadId}`,
          `**状态**：${currentRun ? formatRuntimeStatusLabel(currentRun.status) : "空闲"}`,
          ...this.buildCodexPreferenceSummaryLines(effectivePreferences),
        ],
        sections,
        extraElements: this.buildCodexPreferenceControlElements({
          context: actionContext,
          effectivePreferences,
        }),
        actions,
      }),
    };
  }

  private buildResolvedSessionCardReply(
    input: BridgeMessageInput,
    resolved: ResolvedContext,
  ): BridgeReply {
    const effectivePreferences = this.resolveEffectiveCodexPreferences(input, resolved);
    const preferenceTarget = this.resolveCodexPreferenceTarget(input, resolved);
    const currentRun = this.findCurrentRunForResolved(resolved);
    const contextItems = this.buildContextSummaryItems(input, resolved, currentRun);
    const actionContext = this.buildCardActionContext(input);
    const summaryLines = [
      "**视图**：当前会话",
      `**Root**：${resolved.root.id}`,
      `**状态**：${currentRun ? formatRuntimeStatusLabel(currentRun.status) : "空闲"}`,
    ];
    summaryLines.push(...this.buildContextSummaryLines(input, resolved, currentRun));
    summaryLines.push(...this.buildCodexPreferenceSummaryLines(effectivePreferences));
    const actions: Array<{
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }> = [
      {
        label: "导航",
        type: "primary",
        value: this.buildCardActionValue(actionContext, BRIDGE_COMMAND_PREFIX),
      },
      {
        label: "运行状态",
        value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} status`),
      },
      {
        label: "新会话",
        value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} new`),
      },
    ];
    this.maybePushStopAction(actions, actionContext, currentRun);

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前会话",
        summaryLines,
        sections: [
          currentRun
            ? {
                title: "当前运行",
                items: this.buildCurrentRunItems(currentRun),
              }
            : {
                title: "当前会话",
                items: ["当前没有运行中的任务。"],
              },
          {
            title: "Codex 设置",
            items: this.buildCodexPreferenceSectionItems(effectivePreferences, preferenceTarget),
          },
          {
            title: "当前上下文",
            items: contextItems.length > 0 ? contextItems : ["当前上下文暂不可用。"],
          },
        ],
        extraElements: this.buildCodexPreferenceControlElements({
          context: actionContext,
          effectivePreferences,
        }),
        actions,
      }),
    };
  }

  private buildRunStatusCardReply(
    input: BridgeMessageInput,
    resolved?: ResolvedContext,
    currentRun?: RuntimeRunSnapshot,
  ): BridgeReply {
    const actionContext = this.buildCardActionContext(input);
    const summaryLines = ["**视图**：运行状态"];
    if (resolved?.root.id) {
      summaryLines.push(`**Root**：${resolved.root.id}`);
    }
    if (resolved) {
      summaryLines.push(...this.buildContextSummaryLines(input, resolved, currentRun));
      summaryLines.push(...this.buildCodexPreferenceSummaryLines(
        this.resolveEffectiveCodexPreferences(input, resolved),
      ));
    }
    summaryLines.push(`**状态**：${currentRun ? formatRuntimeStatusLabel(currentRun.status) : "空闲"}`);

    const contextItems = resolved
      ? this.buildContextSummaryItems(input, resolved, currentRun)
      : [];
    const sections: Array<{
      title: string;
      items: string[];
      monospace?: boolean;
    }> = [
      currentRun
        ? {
            title: "当前运行",
            items: this.buildCurrentRunItems(currentRun, true),
          }
        : {
            title: "当前没有运行中的任务",
            items: ["可以直接发送普通消息开始新的任务。"],
          },
    ];

    if (contextItems.length > 0) {
      sections.push({
        title: "当前上下文",
        items: contextItems,
      });
    }
    const actions: Array<{
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }> = [
      {
        label: "导航",
        type: "primary",
        value: this.buildCardActionValue(actionContext, BRIDGE_COMMAND_PREFIX),
      },
      {
        label: "当前会话",
        value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} session`),
      },
    ];
    this.maybePushStopAction(actions, actionContext, currentRun);

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "运行状态",
        summaryLines,
        sections,
        actions,
      }),
    };
  }

  private buildContextSummaryItems(
    input: BridgeMessageInput,
    resolved: ResolvedContext,
    currentRun?: RuntimeRunSnapshot,
  ): string[] {
    const context = this.resolveReadableContext(input, resolved, currentRun);
    const items: string[] = [];
    if (context.projectLabel) {
      items.push(`当前项目：${context.projectLabel}`);
    }
    if (context.threadLabel) {
      items.push(`当前线程：${context.threadLabel}`);
    } else if (this.isDmContext(input)) {
      items.push("当前线程：未选择");
    }
    if (context.threadId) {
      items.push(`线程 ID：${context.threadId}`);
    }
    if (context.deliveryLabel) {
      items.push(`投递位置：${context.deliveryLabel}`);
    }
    if (context.deliveryChatId) {
      items.push(`群聊 ID：${context.deliveryChatId}`);
    }
    if (context.deliverySurfaceRef) {
      items.push(`话题 ID：${context.deliverySurfaceRef}`);
    }

    return items;
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
          `**当前项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `**当前线程**：${formatCurrentThreadLabel(thread.title, thread.threadId)}`,
          `线程 ID：${thread.threadId}`,
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

  private findCurrentRunForResolved(resolved?: ResolvedContext): RuntimeRunSnapshot | undefined {
    if (!resolved) {
      return undefined;
    }

    return this.findCurrentRunByCandidates(
      resolved.concurrencyKey,
      resolved.threadId,
      resolved.threadId ? `codex-thread:${resolved.threadId}` : undefined,
    );
  }

  private findCurrentRunByThreadId(
    threadId?: string | null,
    concurrencyKey?: string,
  ): RuntimeRunSnapshot | undefined {
    if (!threadId && !concurrencyKey) {
      return undefined;
    }

    return this.findCurrentRunByCandidates(
      concurrencyKey,
      threadId,
      threadId ? `codex-thread:${threadId}` : undefined,
    );
  }

  private findCurrentRunByCandidates(
    ...candidates: Array<string | null | undefined>
  ): RuntimeRunSnapshot | undefined {
    if (!this.dependencies.workerManager) {
      return undefined;
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      const normalized = candidate?.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      const run = this.dependencies.workerManager.getCurrentRun(normalized);
      if (run) {
        return run;
      }
    }

    return undefined;
  }

  private getCodexPreferenceCatalog(): CodexPreferenceCatalog {
    return this.dependencies.codexPreferences ?? {
      defaultModel: "gpt-5.4",
      defaultReasoningEffort: "high",
      modelOptions: ["gpt-5.4", "gpt-5.4-mini"],
      reasoningEffortOptions: ["minimal", "low", "medium", "high", "xhigh"],
    };
  }

  private resolveCodexPreferenceTarget(
    input: BridgeMessageInput,
    resolved: ResolvedContext,
  ): CodexPreferenceTarget {
    if (resolved.threadId) {
      return {
        kind: "thread",
        threadId: resolved.threadId,
        surface: {
          channel: input.channel,
          peerId: input.peerId,
          chatId: input.chatId ?? null,
          surfaceType: input.surfaceType ?? null,
          surfaceRef: input.surfaceRef ?? null,
        },
      };
    }

    return {
      kind: "surface",
      surface: {
        channel: input.channel,
        peerId: input.peerId,
        chatId: input.chatId ?? null,
        surfaceType: input.surfaceType ?? null,
        surfaceRef: input.surfaceRef ?? null,
      },
    };
  }

  private resolveEffectiveCodexPreferences(
    input: BridgeMessageInput,
    resolved: ResolvedContext,
  ): EffectiveCodexPreferences {
    const catalog = this.getCodexPreferenceCatalog();
    const threadPreference = resolved.threadId
      ? this.dependencies.store.getCodexThreadPreference(resolved.threadId)
      : undefined;
    if (threadPreference) {
      return {
        model: threadPreference.model,
        reasoningEffort: threadPreference.reasoningEffort,
        source: "thread",
      };
    }

    const surfacePreference = this.dependencies.store.getCodexSurfacePreference({
      channel: input.channel,
      peerId: input.peerId,
      chatId: input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
    });
    if (surfacePreference) {
      return {
        model: surfacePreference.model,
        reasoningEffort: surfacePreference.reasoningEffort,
        source: "surface",
      };
    }

    return {
      model: catalog.defaultModel,
      reasoningEffort: catalog.defaultReasoningEffort,
      source: "default",
    };
  }

  private buildCodexPreferenceSummaryLines(
    effectivePreferences: EffectiveCodexPreferences,
  ): string[] {
    return [
      `**当前模型**：${effectivePreferences.model}`,
      `**推理强度**：${effectivePreferences.reasoningEffort}`,
      `**设置范围**：${formatCodexPreferenceSourceLabel(effectivePreferences.source)}`,
    ];
  }

  private buildCodexPreferenceSectionItems(
    effectivePreferences: EffectiveCodexPreferences,
    target: CodexPreferenceTarget,
  ): string[] {
    return [
      `当前模型：${effectivePreferences.model}`,
      `推理强度：${effectivePreferences.reasoningEffort}`,
      `生效范围：${target.kind === "thread" ? "当前线程" : "当前会话入口"}`,
    ];
  }

  private buildCodexPreferenceControlElements(input: {
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    };
    effectivePreferences: EffectiveCodexPreferences;
  }): Array<Record<string, unknown>> {
    const catalog = this.getCodexPreferenceCatalog();
    return [
      {
        tag: "markdown",
        content: [
          "**Codex 设置**",
          input.effectivePreferences.source === "thread"
            ? "当前选择会直接作用于这个线程的后续运行。"
            : "当前选择会作用于这个飞书会话入口；新线程会继承它。",
        ].join("\n"),
      },
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "default",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "markdown",
                content: "**模型**",
              },
              {
                tag: "select_static",
                initial_option: input.effectivePreferences.model,
                placeholder: {
                  tag: "plain_text",
                  content: "选择模型",
                },
                options: catalog.modelOptions.map(model => ({
                  text: {
                    tag: "plain_text",
                    content: model,
                  },
                  value: model,
                })),
                behaviors: [{
                  type: "callback",
                  value: this.buildCodexPreferenceActionValue(input.context, "set_codex_model"),
                }],
              },
            ],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "markdown",
                content: "**推理强度**",
              },
              {
                tag: "select_static",
                initial_option: input.effectivePreferences.reasoningEffort,
                placeholder: {
                  tag: "plain_text",
                  content: "选择推理强度",
                },
                options: catalog.reasoningEffortOptions.map(reasoningEffort => ({
                  text: {
                    tag: "plain_text",
                    content: reasoningEffort,
                  },
                  value: reasoningEffort,
                })),
                behaviors: [{
                  type: "callback",
                  value: this.buildCodexPreferenceActionValue(input.context, "set_reasoning_effort"),
                }],
              },
            ],
          },
        ],
      },
    ];
  }

  private buildCurrentRunItems(
    currentRun: RuntimeRunSnapshot,
    includeWait = false,
  ): string[] {
    const items = [
      `runId：${currentRun.runId}`,
      `状态：${formatRuntimeStatusLabel(currentRun.status)} / ${formatRuntimeStageLabel(currentRun.stage)}`,
      `已运行：${formatRuntimeDuration(currentRun.elapsedMs)}`,
    ];

    if (includeWait) {
      items.push(`等待：${formatRuntimeDuration(currentRun.waitMs)}`);
    }

    if (currentRun.model) {
      items.push(`模型：${currentRun.model}`);
    }
    if (currentRun.reasoningEffort) {
      items.push(`推理强度：${currentRun.reasoningEffort}`);
    }
    items.push(`最近工具：${currentRun.latestTool ?? "无"}`);
    items.push(`摘要：${normalizeMarkdownToPlainText(currentRun.latestPreview)}`);
    return items;
  }

  private maybePushStopAction(
    actions: Array<{
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }>,
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
    currentRun?: RuntimeRunSnapshot,
  ): void {
    if (!currentRun) {
      return;
    }

    actions.push({
      label: "停止任务",
      type: "danger",
      value: this.buildCardActionValue(context, `${BRIDGE_COMMAND_PREFIX} stop`),
    });
  }

  private buildContextSummaryLines(
    input: BridgeMessageInput,
    resolved: ResolvedContext,
    currentRun?: RuntimeRunSnapshot,
  ): string[] {
    const context = this.resolveReadableContext(input, resolved, currentRun);
    const lines: string[] = [];

    if (context.projectLabel) {
      lines.push(`**当前项目**：${context.projectLabel}`);
    }
    if (context.threadLabel) {
      lines.push(`**当前线程**：${context.threadLabel}`);
    } else if (this.isDmContext(input)) {
      lines.push("**当前线程**：未选择");
    }
    if (context.threadId) {
      lines.push(`线程 ID：${context.threadId}`);
    }

    return lines;
  }

  private resolveReadableContext(
    input: BridgeMessageInput,
    resolved?: ResolvedContext,
    currentRun?: RuntimeRunSnapshot,
  ): {
    projectLabel?: string;
    threadLabel?: string;
    threadId?: string | null;
    deliveryLabel?: string;
    deliveryChatId?: string | null;
    deliverySurfaceRef?: string | null;
  } {
    let projectLabel: string | undefined;
    let threadLabel: string | undefined;
    let threadId: string | null | undefined = currentRun?.threadId ?? resolved?.threadId ?? null;

    if (this.isDmContext(input)) {
      const codexSelection = this.lookupDmCodexSelection(input);
      if (codexSelection) {
        projectLabel = codexSelection.project.displayName;
        threadLabel = formatCurrentThreadLabel(codexSelection.thread.title, codexSelection.thread.threadId);
        threadId = codexSelection.thread.threadId;
      } else {
        const selectedProject = this.lookupDmSelectedProject(input);
        if (selectedProject) {
          projectLabel = selectedProject.displayName;
        }
      }
    } else if (input.surfaceType === "thread" && input.chatId && input.surfaceRef) {
      const thread = this.dependencies.store.getCodexThreadBySurface(input.chatId, input.surfaceRef);
      if (thread) {
        const project = this.dependencies.store.getProject(thread.projectId);
        projectLabel = project?.name ?? thread.projectId;
        threadLabel = formatCurrentThreadLabel(thread.title, thread.threadId);
        threadId = thread.threadId;
      }
    } else if (input.chatId) {
      const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
      if (projectChat) {
        const project = this.dependencies.store.getProject(projectChat.projectId);
        projectLabel = project?.name ?? projectChat.projectId;
      }
    }

    const deliveryChatId = currentRun?.deliveryChatId ?? resolved?.deliveryChatId ?? input.chatId ?? null;
    const deliverySurfaceRef = currentRun?.deliverySurfaceRef ?? resolved?.deliverySurfaceRef ?? input.surfaceRef ?? null;
    const deliveryLabel = deliverySurfaceRef
      ? "当前飞书线程"
      : deliveryChatId
        ? "当前群聊"
        : "当前私聊";

    return {
      projectLabel,
      threadLabel,
      threadId,
      deliveryLabel,
      deliveryChatId,
      deliverySurfaceRef,
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

    const selectedProject = this.dependencies.store.getCodexProjectSelection(input.channel, input.peerId);
    if (selectedProject) {
      const selectedCatalogProject = this.dependencies.codexCatalog.getProject(selectedProject.projectKey, {
        includeArchived: true,
      });
      if (!selectedCatalogProject) {
        this.dependencies.store.clearCodexProjectSelection(input.channel, input.peerId);
      } else if (selectedCatalogProject.projectKey !== project.projectKey) {
        this.dependencies.store.clearCodexWindowBinding(input.channel, input.peerId);
        return undefined;
      }
    }

    return {
      binding,
      project,
      thread,
    };
  }

  private lookupDmSelectedProject(input: BridgeMessageInput): CodexCatalogProject | undefined {
    if (!this.isDmContext(input) || !this.dependencies.codexCatalog) {
      return undefined;
    }

    const selection = this.dependencies.store.getCodexProjectSelection(input.channel, input.peerId);
    if (!selection) {
      return undefined;
    }

    const project = this.dependencies.codexCatalog.getProject(selection.projectKey, {
      includeArchived: true,
    });
    if (!project) {
      this.dependencies.store.clearCodexProjectSelection(input.channel, input.peerId);
      return undefined;
    }

    return project;
  }

  private isNativeCatalogThread(threadId: string): boolean {
    if (!this.dependencies.codexCatalog) {
      return true;
    }

    return Boolean(this.dependencies.codexCatalog.getThread(threadId));
  }

  private listCatalogProjectChatBindings(): CatalogProjectChatBinding[] {
    return this.dependencies.store.listProjects()
      .map(project => {
        const record = this.dependencies.store.getProject(project.projectId);
        if (!record) {
          return undefined;
        }

        return {
          projectId: project.projectId,
          cwd: record.cwd,
          chatId: project.chatId,
        };
      })
      .filter((binding): binding is CatalogProjectChatBinding => Boolean(binding));
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
    effectivePreferences: EffectiveCodexPreferences,
  ): Promise<ResolvedContext> {
    if (resolved.context.targetKind !== "new_codex_thread") {
      return resolved;
    }

    const createThreadInput: {
      cwd: string;
      prompt: string;
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
    } = {
      cwd: resolved.context.cwd,
      prompt: buildNativeThreadBootstrapPrompt(resolved.context.threadTitle ?? prompt),
    };
    if (effectivePreferences.source !== "default") {
      createThreadInput.model = effectivePreferences.model;
      createThreadInput.reasoningEffort = effectivePreferences.reasoningEffort;
    }
    const created = await this.dependencies.runner.createThread(createThreadInput);
    this.dependencies.store.upsertCodexThreadPreference({
      threadId: created.threadId,
      model: effectivePreferences.model,
      reasoningEffort: effectivePreferences.reasoningEffort,
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

  private buildCodexPreferenceActionValue(
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
    bridgeAction: "set_codex_model" | "set_reasoning_effort",
  ): Record<string, unknown> {
    return {
      bridgeAction,
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

function lookupCatalogProjectChatBinding(
  project: CodexCatalogProject,
  bindings: CatalogProjectChatBinding[],
  currentChatId: string | null,
): (
  | { state: "current"; chatId: string }
  | { state: "other"; chatId: string }
  | { state: "unbound"; chatId: null }
) {
  const matches = bindings.filter(binding =>
    binding.projectId === project.projectKey ||
    normalizePathKey(binding.cwd) === normalizePathKey(project.cwd)
  );
  const current = matches.find(binding => binding.chatId && binding.chatId === currentChatId);
  if (current?.chatId) {
    return {
      state: "current",
      chatId: current.chatId,
    };
  }

  const other = matches.find(binding => binding.chatId && binding.chatId !== currentChatId);
  if (other?.chatId) {
    return {
      state: "other",
      chatId: other.chatId,
    };
  }

  return {
    state: "unbound",
    chatId: null,
  };
}

function formatGroupProjectBinding(input: {
  state: "current" | "other" | "unbound";
  chatId: string | null;
}): string {
  if (input.state === "current") {
    return "已绑定当前群";
  }
  if (input.state === "other") {
    return `已绑定其他群（${input.chatId ?? "unknown"}）`;
  }
  return "未绑定";
}

function buildGroupProjectButtons(input: {
  bindingState: "current" | "other" | "unbound";
  currentChatId?: string;
  currentProjectValue: Record<string, unknown>;
  bindValue: Record<string, unknown>;
}): Array<{
  label: string;
  value: Record<string, unknown>;
  type?: "default" | "primary" | "danger";
}> {
  if (input.bindingState === "current") {
    return [{
      label: "当前项目",
      type: "primary",
      value: input.currentProjectValue,
    }];
  }

  if (input.bindingState === "unbound" && input.currentChatId) {
    return [{
      label: "绑定到本群",
      type: "primary",
      value: input.bindValue,
    }];
  }

  return [];
}

function formatCodexPreferenceSourceLabel(source: EffectiveCodexPreferences["source"]): string {
  switch (source) {
    case "thread":
      return "当前线程";
    case "surface":
      return "当前会话入口";
    case "default":
      return "系统默认";
  }
}

function normalizeCodexModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildSessionName(rootId: string): string {
  return `codex-${rootId}`;
}

function buildRunId(): string {
  return `run-${randomUUID()}`;
}

function formatCurrentThreadLabel(title: string, fallbackThreadId: string): string {
  const normalizedTitle = title.trim();
  return normalizedTitle.length > 0 ? normalizedTitle : fallbackThreadId;
}

function orderCodexThreadsForParentChildDisplay(threads: CodexCatalogThread[]): CodexCatalogThread[] {
  const threadById = new Map(threads.map(thread => [thread.threadId, thread]));
  const childrenByParent = new Map<string, CodexCatalogThread[]>();
  const nestedChildThreadIds = new Set<string>();

  for (const thread of threads) {
    const sourceInfo = getCodexThreadSourceInfo(thread);
    if (
      sourceInfo.kind !== "subagent" ||
      !sourceInfo.parentThreadId ||
      sourceInfo.parentThreadId === thread.threadId ||
      !threadById.has(sourceInfo.parentThreadId)
    ) {
      continue;
    }

    const children = childrenByParent.get(sourceInfo.parentThreadId) ?? [];
    children.push(thread);
    childrenByParent.set(sourceInfo.parentThreadId, children);
    nestedChildThreadIds.add(thread.threadId);
  }

  const visited = new Set<string>();
  const ordered: CodexCatalogThread[] = [];
  const roots = threads
    .filter(thread => !nestedChildThreadIds.has(thread.threadId))
    .sort((left, right) => compareCodexThreadGroupActivity(right, left, childrenByParent, new Set()));

  const visit = (thread: CodexCatalogThread) => {
    if (visited.has(thread.threadId)) {
      return;
    }

    visited.add(thread.threadId);
    ordered.push(thread);

    const children = (childrenByParent.get(thread.threadId) ?? [])
      .sort((left, right) => compareCodexThreadGroupActivity(right, left, childrenByParent, new Set()));
    for (const child of children) {
      visit(child);
    }
  };

  for (const root of roots) {
    visit(root);
  }

  return ordered;
}

function compareCodexThreadGroupActivity(
  left: CodexCatalogThread,
  right: CodexCatalogThread,
  childrenByParent: Map<string, CodexCatalogThread[]>,
  seen: Set<string>,
): number {
  const leftLatest = latestCodexThreadGroupUpdatedAt(left, childrenByParent, new Set(seen));
  const rightLatest = latestCodexThreadGroupUpdatedAt(right, childrenByParent, new Set(seen));

  return leftLatest.localeCompare(rightLatest);
}

function latestCodexThreadGroupUpdatedAt(
  thread: CodexCatalogThread,
  childrenByParent: Map<string, CodexCatalogThread[]>,
  seen: Set<string>,
): string {
  if (seen.has(thread.threadId)) {
    return thread.updatedAt;
  }

  seen.add(thread.threadId);
  const childLatest = (childrenByParent.get(thread.threadId) ?? [])
    .map(child => latestCodexThreadGroupUpdatedAt(child, childrenByParent, seen))
    .sort((left, right) => right.localeCompare(left))[0];

  return childLatest && childLatest > thread.updatedAt ? childLatest : thread.updatedAt;
}

function formatCodexThreadListTitle(thread: CodexCatalogThread): string {
  const sourceInfo = getCodexThreadSourceInfo(thread);
  return sourceInfo.kind === "subagent" ? `└ ${thread.title}` : thread.title;
}

function formatCodexThreadListLines(
  thread: CodexCatalogThread,
  threadById: Map<string, CodexCatalogThread>,
): string[] {
  const sourceInfo = getCodexThreadSourceInfo(thread);

  if (sourceInfo.kind === "subagent") {
    return [
      `身份：子 agent · ${formatSubagentIdentity(sourceInfo)}`,
      `父线程：${formatParentThreadLabel(sourceInfo.parentThreadId, threadById)}`,
      `线程 ID：${thread.threadId}${formatSubagentDepth(sourceInfo)}`,
      `最近更新：${thread.updatedAt}`,
    ];
  }

  return [
    `线程 ID：${thread.threadId}`,
    `身份：母 agent · 来源：${sourceInfo.label} · 分支：${thread.gitBranch ?? "unknown"}`,
    `最近更新：${thread.updatedAt}`,
  ];
}

function getCodexThreadSourceInfo(thread: CodexCatalogThread): CodexCatalogThreadSourceInfo {
  return thread.sourceInfo ?? parseCodexThreadSourceInfo(thread.source);
}

function formatSubagentIdentity(sourceInfo: CodexCatalogThreadSourceInfo): string {
  const parts = [sourceInfo.agentNickname, sourceInfo.agentRole]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" / ") : "未命名";
}

function formatParentThreadLabel(
  parentThreadId: string | undefined,
  threadById: Map<string, CodexCatalogThread>,
): string {
  if (!parentThreadId) {
    return "未知";
  }

  const parent = threadById.get(parentThreadId);
  if (!parent) {
    return `${formatThreadIdReference(parentThreadId)}（不在当前列表）`;
  }

  return `${truncateCardLineText(parent.title, 32)}（${formatThreadIdReference(parent.threadId)}）`;
}

function formatSubagentDepth(sourceInfo: CodexCatalogThreadSourceInfo): string {
  return typeof sourceInfo.depth === "number" ? ` · 层级：${sourceInfo.depth}` : "";
}

function formatThreadIdReference(threadId: string): string {
  return threadId.length > 18 ? `${threadId.slice(0, 8)}...${threadId.slice(-4)}` : threadId;
}

function truncateCardLineText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
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

function findFinalAssistantText(events: RunnerEvent[]): string {
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

function formatRuntimeStatusLabel(status: RuntimeRunSnapshot["status"]): string {
  switch (status) {
    case "queued":
      return "已接收";
    case "preparing":
      return "准备中";
    case "canceling":
      return "停止中";
    case "running":
      return "处理中";
    case "tool_active":
      return "工具执行中";
    case "waiting":
      return "等待中";
    case "done":
      return "已完成";
    case "error":
      return "失败";
    case "canceled":
      return "已停止";
  }
}

function formatRuntimeStageLabel(stage: RuntimeRunSnapshot["stage"]): string {
  switch (stage) {
    case "received":
      return "已接收";
    case "resolving_context":
      return "解析上下文";
    case "ensuring_session":
      return "准备会话";
    case "session_ready":
      return "会话已就绪";
    case "submitting_prompt":
      return "提交请求";
    case "waiting_first_event":
      return "等待首个响应";
    case "canceling":
      return "停止中";
    case "tool_call":
      return "工具调用";
    case "text":
      return "文本响应";
    case "waiting":
      return "等待中";
    case "done":
      return "已完成";
    case "error":
      return "失败";
    case "canceled":
      return "已停止";
  }
}

function formatRuntimeDuration(elapsedMs: number): string {
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }

  const seconds = elapsedMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
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

function buildPromptForCodexRun(input: {
  root: RootProfile;
  prompt: string;
  wrapPrompt: boolean;
  assets: BridgeAssetRecord[];
}): string {
  if (!input.wrapPrompt && input.assets.length === 0) {
    return input.prompt;
  }

  const sections: string[] = [];

  if (input.wrapPrompt) {
    sections.push(
      "[bridge-context]",
      `root_name: ${input.root.id}`,
      `root_path: ${input.root.cwd}`,
      "instructions:",
      "- You are operating inside the configured bridge root.",
      "- Discover projects and repositories under this root yourself.",
      "- If the user asks about available projects, inspect the filesystem and answer directly.",
      `- Do not tell the user to use ${BRIDGE_COMMAND_PREFIX} repo commands because bridge does not manage projects.`,
      "[/bridge-context]",
      "",
    );
  }

  if (input.assets.length > 0) {
    sections.push(
      "[bridge-attachments]",
      `image_count: ${input.assets.length}`,
      ...input.assets.map((asset, index) =>
        `image_${index + 1}: file_name=${asset.fileName}; source_message_id=${asset.messageId}; mime_type=${asset.mimeType ?? "unknown"}`,
      ),
      "[/bridge-attachments]",
      "",
    );
  }

  sections.push(
    "[user-message]",
    input.prompt,
    "[/user-message]",
  );

  return sections.join("\n");
}

function buildFinalBridgeReplies(input: {
  finalText: string;
  cwd: string;
  managedAssetRootDir: string;
}): {
  previewText: string;
  replies: BridgeReply[];
} {
  const parsed = parseBridgeImageDirective(input.finalText);
  const replies: BridgeReply[] = [];
  const fallbackTexts = [...parsed.errors];
  const captionTexts: string[] = [];

  for (const image of parsed.images) {
    const validation = validateBridgeImagePath({
      candidatePath: image.localPath,
      cwd: input.cwd,
      managedAssetRootDir: input.managedAssetRootDir,
    });
    if (!validation.ok) {
      fallbackTexts.push(validation.errorText);
      continue;
    }

    replies.push({
      kind: "image",
      localPath: validation.image.localPath,
      caption: image.caption,
    });
    if (image.caption) {
      captionTexts.push(image.caption);
    }
  }

  const assistantText = parsed.cleanedText || captionTexts.join("\n\n");
  if (assistantText) {
    replies.unshift({
      kind: "assistant",
      text: assistantText,
    });
  }

  for (const text of fallbackTexts) {
    replies.push({
      kind: "system",
      text,
    });
  }

  if (replies.length === 0) {
    replies.push({
      kind: "assistant",
      text: input.finalText,
    });
  }

  return {
    previewText: assistantText || fallbackTexts[0] || "[ca] image reply generated",
    replies,
  };
}
