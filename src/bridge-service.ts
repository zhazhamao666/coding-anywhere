import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  DEFAULT_BRIDGE_ASSET_ROOT_DIR,
  parseBridgeImageDirective,
  validateBridgeImagePath,
} from "./bridge-image-directive.js";
import { BRIDGE_COMMAND_PREFIX, routeBridgeInput } from "./command-router.js";
import {
  getCodexModelLabel,
  getCodexReasoningLabel,
  getCodexSpeedLabel,
  getFallbackCodexPreferenceCatalog,
  normalizeCodexModel,
  normalizeCodexSpeed,
  normalizeReasoningEffort,
} from "./codex-preferences.js";
import { parseCodexThreadSourceInfo } from "./codex-thread-source.js";
import { buildFeishuVisibleAssistantText } from "./feishu-assistant-message.js";
import {
  buildCommandActionValue as buildSharedCommandActionValue,
  buildPlanModeToggleActionValue,
  buildPreferenceActionValue as buildSharedPreferenceActionValue,
} from "./feishu-card/action-contract.js";
import { buildBridgeHubCard } from "./feishu-card/navigation-card-builder.js";
import { normalizeMarkdownToPlainText } from "./markdown-text.js";
import type { ProjectThreadService } from "./project-thread-service.js";
import { createProgressCardState, reduceProgressEvent } from "./progress-relay.js";
import {
  formatRuntimeStageLabel,
  formatRuntimeStatusLabel,
} from "./runtime-status-labels.js";
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
  CodexSpeed,
  CodexCatalogThread,
  CodexCatalogThreadSourceInfo,
  PendingPlanInteractionRecord,
  RootProfile,
  StableSessionCardModel,
  ProgressCardState,
  RuntimeRunSnapshot,
  RunContext,
  RunOutcome,
  RunnerEvent,
  SurfaceInteractionStateRecord,
} from "./types.js";
import { SessionStore } from "./workspace/session-store.js";

const MAX_CODEX_THREAD_SELECTION_ROWS = 12;
const MAX_CODEX_THREAD_LIST_TITLE_CHARS = 80;
const MAX_CODEX_THREAD_LIST_LINE_CHARS = 96;

interface BridgeRunner {
  createThread(
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
  ): Promise<RunOutcome & { threadId: string }>;
  ensureSession(context: RunContext): Promise<void>;
  submitVerbatim(
    context: RunContext,
    prompt: string,
    optionsOrOnEvent?: {
      images?: string[];
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
      speed?: CodexSpeed;
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
  speed: CodexSpeed;
  source: "thread" | "surface" | "default";
}

interface DesktopCompletionRouteTarget {
  mode: "thread" | "project_group" | "dm";
  peerId?: string;
  chatId?: string;
  surfaceRef?: string;
  anchorMessageId?: string;
}

interface DmCodexCatalogSelection {
  binding: { codexThreadId: string };
  project: CodexCatalogProject;
  thread: CodexCatalogThread;
}

interface DesktopThreadContinuationResult {
  reply: BridgeReply;
  topicReply?: {
    anchorMessageId: string;
    reply: BridgeReply;
  };
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

  public async handleSessionCardUiAction(input: {
    channel: string;
    peerId: string;
    action: "toggle_plan_mode" | "open_diagnostics" | "close_diagnostics";
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  }): Promise<BridgeReply> {
    const nextState = this.getSurfaceInteractionState(input);
    if (input.action === "toggle_plan_mode") {
      nextState.sessionMode = nextState.sessionMode === "plan_next_message" ? "normal" : "plan_next_message";
    } else if (input.action === "open_diagnostics") {
      nextState.diagnosticsOpen = true;
    } else {
      nextState.diagnosticsOpen = false;
    }

    this.dependencies.store.upsertSurfaceInteractionState({
      ...this.normalizeSurfaceIdentity(input),
      sessionMode: nextState.sessionMode,
      diagnosticsOpen: nextState.diagnosticsOpen,
    });

    const [reply] = await this.handleMessage({
      channel: input.channel,
      peerId: input.peerId,
      chatType: input.chatType,
      chatId: input.chatId,
      surfaceType: input.surfaceType,
      surfaceRef: input.surfaceRef,
      text: `${BRIDGE_COMMAND_PREFIX} session`,
    });

    return reply ?? {
      kind: "system",
      text: "[ca] current session unavailable",
    };
  }

  public resolveDesktopCompletionRoute(input: {
    threadId: string;
    allowlist: string[];
    desktopOwnerOpenId?: string;
    routeValidator?: (target: DesktopCompletionRouteTarget) => boolean;
  }): DesktopCompletionRouteTarget {
    const validateTarget = input.routeValidator ?? (() => true);
    const inferredDmPeerId = this.resolveDesktopCompletionDmPeer(input.threadId);
    const existingSurface = this.dependencies.store.getPreferredCodexThreadBinding(input.threadId);
    if (existingSurface?.chatId && existingSurface.feishuThreadId && existingSurface.anchorMessageId) {
      const threadTarget: DesktopCompletionRouteTarget = {
        mode: "thread",
        chatId: existingSurface.chatId,
        surfaceRef: existingSurface.feishuThreadId,
        anchorMessageId: existingSurface.anchorMessageId,
      };
      if (validateTarget(threadTarget)) {
        return threadTarget;
      }

      return buildDesktopCompletionDmTarget({
        ...input,
        inferredDmPeerId,
      });
    }

    const groupTarget = this.resolveDesktopCompletionProjectGroupRoute(input.threadId);
    if (groupTarget) {
      if (validateTarget(groupTarget)) {
        return groupTarget;
      }

      return buildDesktopCompletionDmTarget({
        ...input,
        inferredDmPeerId,
      });
    }

    return buildDesktopCompletionDmTarget({
      ...input,
      inferredDmPeerId,
    });
  }

  public async continueDesktopThread(input: {
    channel: string;
    peerId: string;
    threadId: string;
    mode: "dm" | "project_group" | "thread";
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  }): Promise<DesktopThreadContinuationResult> {
    if (input.mode === "thread") {
      return this.continueDesktopThreadInTopic(input);
    }

    if (input.mode === "project_group") {
      return this.continueDesktopThreadInProjectGroup(input);
    }

    const selection = this.lookupCatalogThreadSelection(input.threadId);
    if (!selection) {
      return {
        reply: this.dependencies.codexCatalog?.getThread(input.threadId)
          ? this.buildCodexProjectUnavailableCardReply({
              channel: input.channel,
              peerId: input.peerId,
              text: `${BRIDGE_COMMAND_PREFIX} session`,
            })
          : this.buildCodexThreadUnavailableCardReply({
              channel: input.channel,
              peerId: input.peerId,
              text: `${BRIDGE_COMMAND_PREFIX} session`,
            }),
      };
    }

    this.bindDmToCodexThread({
      channel: input.channel,
      peerId: input.peerId,
      thread: selection.thread,
    });
    const recentConversation = this.dependencies.codexCatalog?.listRecentConversation(selection.thread.threadId) ?? [];

    return {
      reply: this.buildCodexThreadSwitchedCardReply(
        {
          channel: input.channel,
          peerId: input.peerId,
          chatType: input.chatType,
          text: `${BRIDGE_COMMAND_PREFIX} thread switch ${selection.thread.threadId}`,
        },
        selection.project,
        selection.thread,
        selectSwitchCardConversation(recentConversation),
      ),
    };
  }

  private async continueDesktopThreadInTopic(input: {
    channel: string;
    peerId: string;
    threadId: string;
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  }): Promise<DesktopThreadContinuationResult> {
    const selection = this.lookupCatalogThreadSelection(input.threadId);
    if (!selection) {
      return {
        reply: this.dependencies.codexCatalog?.getThread(input.threadId)
          ? this.buildCodexProjectUnavailableCardReply({
              channel: input.channel,
              peerId: input.peerId,
              text: `${BRIDGE_COMMAND_PREFIX} session`,
            })
          : this.buildCodexThreadUnavailableCardReply({
              channel: input.channel,
              peerId: input.peerId,
              text: `${BRIDGE_COMMAND_PREFIX} session`,
            }),
      };
    }

    if (!input.chatId || input.surfaceType !== "thread" || !input.surfaceRef) {
      return {
        reply: {
          kind: "system",
          text: "[ca] desktop completion topic surface is unavailable",
        },
      };
    }

    this.dependencies.store.rebindCodexThreadSurface({
      chatId: input.chatId,
      feishuThreadId: input.surfaceRef,
      threadId: selection.thread.threadId,
      sessionName: selection.thread.threadId,
      title: selection.thread.title,
      status: "warm",
    });
    const recentConversation = this.dependencies.codexCatalog?.listRecentConversation(selection.thread.threadId) ?? [];

    return {
      reply: this.buildCodexThreadSwitchedCardReply(
        {
          channel: input.channel,
          peerId: input.peerId,
          chatType: input.chatType,
          chatId: input.chatId,
          surfaceType: "thread",
          surfaceRef: input.surfaceRef,
          text: `${BRIDGE_COMMAND_PREFIX} thread switch ${selection.thread.threadId}`,
        },
        selection.project,
        selection.thread,
        selectSwitchCardConversation(recentConversation),
      ),
    };
  }

  private async continueDesktopThreadInProjectGroup(input: {
    channel: string;
    peerId: string;
    threadId: string;
    chatType?: "p2p" | "group";
    chatId?: string;
  }): Promise<DesktopThreadContinuationResult> {
    const selection = this.lookupCatalogThreadSelection(input.threadId);
    if (!selection) {
      return {
        reply: this.dependencies.codexCatalog?.getThread(input.threadId)
          ? this.buildCodexProjectUnavailableCardReply({
              channel: input.channel,
              peerId: input.peerId,
              text: `${BRIDGE_COMMAND_PREFIX} session`,
            })
          : this.buildCodexThreadUnavailableCardReply({
              channel: input.channel,
              peerId: input.peerId,
              text: `${BRIDGE_COMMAND_PREFIX} session`,
            }),
      };
    }

    if (!input.chatId) {
      return {
        reply: {
          kind: "system",
          text: "[ca] desktop completion project-group context is unavailable",
        },
      };
    }

    const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
    if (!projectChat) {
      throw new Error("PROJECT_CHAT_CONTEXT_REQUIRED");
    }
    if (!this.matchesProjectChatSelection(projectChat.projectId, selection.thread)) {
      return {
        reply: this.buildCodexThreadUnavailableCardReply({
          channel: input.channel,
          peerId: input.peerId,
          chatId: input.chatId,
          text: `${BRIDGE_COMMAND_PREFIX} session`,
        }),
      };
    }

    this.bindGroupChatToCodexThread({
      channel: input.channel,
      chatId: projectChat.chatId,
      thread: selection.thread,
    });
    const recentConversation = this.dependencies.codexCatalog?.listRecentConversation(selection.thread.threadId) ?? [];

    return {
      reply: this.buildCodexThreadSwitchedCardReply(
        {
          channel: input.channel,
          peerId: input.peerId,
          chatType: input.chatType,
          chatId: projectChat.chatId,
          text: `${BRIDGE_COMMAND_PREFIX} thread switch ${selection.thread.threadId}`,
        },
        selection.project,
        selection.thread,
        selectSwitchCardConversation(recentConversation),
      ),
    };
  }

  public async handleMessage(input: BridgeMessageInput, options?: {
    onProgress?: (snapshot: ProgressCardState) => Promise<void> | void;
  }): Promise<BridgeReply[]> {
    const routed = routeBridgeInput(input.text);

    if (routed.kind === "command") {
      return this.handleCommand(input, routed.command.name, routed.command.args);
    }

    const surfaceInteractionState = this.getSurfaceInteractionState(input);
    const effectivePromptText = surfaceInteractionState.sessionMode === "plan_next_message"
      ? this.wrapPromptAsSingleUsePlanMessage(routed.prompt)
      : routed.prompt;
    if (surfaceInteractionState.sessionMode === "plan_next_message") {
      this.dependencies.store.upsertSurfaceInteractionState({
        ...this.normalizeSurfaceIdentity(input),
        sessionMode: "normal",
        diagnosticsOpen: surfaceInteractionState.diagnosticsOpen,
      });
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
      speed: effectivePreferences.speed,
      modelOptions: this.getCodexPreferenceCatalog().modelOptions,
      reasoningEffortOptions: this.getCodexPreferenceCatalog().reasoningEffortOptions,
      speedOptions: this.getCodexPreferenceCatalog().speedOptions,
      deliveryChatType: input.chatType ?? (resolved.deliveryChatId ? "group" : "p2p"),
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
        prompt: effectivePromptText,
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
        const shouldForwardSpeed = effectivePreferences.source !== "default" || effectivePreferences.speed === "fast";
        if (imagePaths.length > 0 || effectivePreferences.source !== "default" || shouldForwardSpeed) {
          const runnerOptions: {
            images?: string[];
            model?: string;
            reasoningEffort?: CodexReasoningEffort;
            speed?: CodexSpeed;
          } = {};
          if (imagePaths.length > 0) {
            runnerOptions.images = imagePaths;
          }
          if (effectivePreferences.source !== "default") {
            runnerOptions.model = effectivePreferences.model;
            runnerOptions.reasoningEffort = effectivePreferences.reasoningEffort;
          }
          if (shouldForwardSpeed) {
            runnerOptions.speed = effectivePreferences.speed;
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
      speed: effectivePreferences.speed,
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
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    speed?: CodexSpeed;
  }): Promise<BridgeReply> {
    const sessionInput: BridgeMessageInput = {
      channel: input.channel,
      peerId: input.peerId,
      chatType: input.chatType,
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
    const nextSpeed = normalizeCodexSpeed(input.speed) ?? effectivePreferences.speed;

    if (target.kind === "thread" && target.threadId) {
      this.dependencies.store.upsertCodexThreadPreference({
        threadId: target.threadId,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
        speed: nextSpeed,
      });
    } else {
      this.dependencies.store.upsertCodexSurfacePreference({
        ...target.surface,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
        speed: nextSpeed,
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
    chatType?: "p2p" | "group";
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

    if (this.isDmContext(input)) {
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
        chatType: input.chatType,
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
          speed?: CodexSpeed;
        } = {
          cwd: resolved.context.cwd,
          prompt: buildNativeThreadBootstrapPrompt(currentThread?.title ?? resolved.threadId ?? resolved.sessionName),
        };
        if (effectivePreferences.source !== "default") {
          createThreadInput.model = effectivePreferences.model;
          createThreadInput.reasoningEffort = effectivePreferences.reasoningEffort;
        }
        if (effectivePreferences.source !== "default" || effectivePreferences.speed === "fast") {
          createThreadInput.speed = effectivePreferences.speed;
        }
        const created = await this.dependencies.runner.createThread(createThreadInput);
        this.dependencies.store.upsertCodexThreadPreference({
          threadId: created.threadId,
          model: effectivePreferences.model,
          reasoningEffort: effectivePreferences.reasoningEffort,
          speed: effectivePreferences.speed,
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
          return [this.buildResolvedSessionCardReply(input, this.resolveContext(input))];
        }

        if (this.isGroupMainlineContext(input) && input.chatId) {
          const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
          if (!projectChat) {
            throw new Error("PROJECT_CHAT_CONTEXT_REQUIRED");
          }

          this.dependencies.store.bindCodexChat({
            channel: input.channel,
            chatId: input.chatId,
            codexThreadId: created.threadId,
          });
          return [this.buildResolvedSessionCardReply(input, this.resolveContext(input))];
        }

        this.dependencies.store.bindCodexWindow({
          channel: input.channel,
          peerId: input.peerId,
          codexThreadId: created.threadId,
        });
        return [this.buildResolvedSessionCardReply(input, this.resolveContext(input))];
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
        return this.handleHubCommand(input);
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
      if (this.isGroupMainlineContext(input) && input.chatId && this.dependencies.codexCatalog) {
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

      if (!this.isGroupMainlineContext(input) || !input.chatId) {
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
    if (isBindCurrent && !this.isGroupMainlineContext(input)) {
      throw new Error("PROJECT_CHAT_CONTEXT_REQUIRED");
    }
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
      this.dependencies.store.clearCodexChatBinding(input.channel, chatId);
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
        this.bindDmToCodexThread({
          channel: input.channel,
          peerId: input.peerId,
          thread,
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
        const recentConversation = this.dependencies.codexCatalog.listRecentConversation(thread.threadId);
        return [
          this.buildCurrentCodexSessionCardReply(
            input,
            project,
            thread,
            selectSwitchCardConversation(recentConversation),
          ),
        ];
      }

      if (this.isGroupMainlineContext(input) && input.chatId) {
        const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
        if (!projectChat) {
          throw new Error("PROJECT_CHAT_CONTEXT_REQUIRED");
        }
        if (!this.matchesProjectChatSelection(projectChat.projectId, thread)) {
          return [this.buildCodexThreadUnavailableCardReply(input)];
        }

        this.bindGroupChatToCodexThread({
          channel: input.channel,
          chatId: projectChat.chatId,
          thread,
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
        ? this.isGroupMainlineContext(input) && input.chatId
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
      ? this.isGroupMainlineContext(input) && input.chatId
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

    if (this.isGroupMainlineContext(input) && input.chatId) {
      const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
      if (projectChat) {
        const project = this.dependencies.store.getProject(projectChat.projectId);
        if (!project) {
          throw new Error("PROJECT_NOT_REGISTERED");
        }
        const groupBinding = this.dependencies.store.getCodexChatBinding(input.channel, projectChat.chatId);
        if (groupBinding) {
          const groupSelection = this.lookupGroupChatCodexSelection(input.channel, projectChat);
          if (groupSelection) {
            return {
              root,
              wrapPrompt: false,
              sessionName: groupSelection.thread.threadId,
              projectId: groupSelection.project.projectKey,
              threadId: groupSelection.thread.threadId,
              deliveryChatId: input.chatId,
              deliverySurfaceType: null,
              deliverySurfaceRef: null,
              concurrencyKey: `codex-thread:${groupSelection.thread.threadId}`,
              context: {
                targetKind: "codex_thread",
                threadId: groupSelection.thread.threadId,
                sessionName: groupSelection.thread.threadId,
                cwd: groupSelection.thread.cwd,
              },
            };
          }

          return {
            root,
            wrapPrompt: false,
            sessionName: groupBinding.codexThreadId,
            projectId: project.projectId,
            threadId: groupBinding.codexThreadId,
            deliveryChatId: input.chatId,
            deliverySurfaceType: null,
            deliverySurfaceRef: null,
            concurrencyKey: `codex-thread:${groupBinding.codexThreadId}`,
            context: {
              targetKind: "codex_thread",
              threadId: groupBinding.codexThreadId,
              sessionName: groupBinding.codexThreadId,
              cwd: project.cwd,
            },
          };
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
    this.dependencies.store.clearCodexChatBinding(input.channel, input.chatId);
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
              "可以先查看这个项目的线程列表，再切换到已有线程。",
              "也可以直接在本群发送普通消息，在该项目下创建新的 native Codex thread。",
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
            items: [
              "可直接查看线程列表并切换到已有线程。",
              "也可以直接在本群发送普通消息，在当前项目下创建新的 native Codex thread。",
            ],
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
          {
            label: "新会话",
            value: this.buildCardActionValue({ chatId: input.chatId }, `${BRIDGE_COMMAND_PREFIX} new`),
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

  private buildCodexThreadLinkedCardReply(
    input: BridgeMessageInput,
    project: CodexCatalogProject,
    linkedThread: {
      threadId: string;
      chatId: string;
      title: string;
      status?: string;
    },
    recentConversation: CodexCatalogConversationItem[],
  ): BridgeReply {
    const conversationItems = recentConversation.length > 0
      ? recentConversation.map(item => this.formatConversationPreviewItem(item))
      : ["暂未读取到可展示的最近对话。"];

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "线程已绑定",
        summaryLines: [
          "**视图**：线程已绑定",
          `**当前项目**：${project.displayName}`,
          `**路径**：${project.cwd}`,
          `**当前线程**：${formatCurrentThreadLabel(linkedThread.title, linkedThread.threadId)}`,
          `线程 ID：${linkedThread.threadId}`,
          `**群聊**：${linkedThread.chatId}`,
          `**状态**：${linkedThread.status ?? "provisioned"}`,
        ],
        sections: [
          {
            title: "最近对话",
            items: conversationItems,
          },
          {
            title: "下一步",
            items: [
              "已在本群创建新的飞书话题，并把它绑定到这个现有 Codex 线程。",
              "进入新话题后直接发送普通消息，后续内容会继续进入这个 Codex 线程。",
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
        ],
      }),
    };
  }

  private buildDesktopContinuationMovedToTopicCardReply(input: {
    chatId: string;
    threadId: string;
    threadTitle: string;
  }): BridgeReply {
    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "已在飞书继续",
        summaryLines: [
          "**视图**：已在飞书继续",
          `**当前线程**：${formatCurrentThreadLabel(input.threadTitle, input.threadId)}`,
          "已把这个线程接到新的飞书话题。",
        ],
        sections: [
          {
            title: "下一步",
            items: ["已在新的飞书话题里发送“线程已切换”卡，请进入该话题继续。"],
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
        title: "选择项目",
        summaryLines: [
          `**当前可用项目**：${projects.length}`,
        ],
        sections: projects.length > 0
          ? []
          : [
              {
                title: "当前没有可用项目",
                items: ["当前 Codex 线程库中没有可用项目。"],
              },
            ],
        rows: projects.map(project => ({
          title: project.displayName,
          lines: [
            `线程：${project.activeThreadCount}/${project.threadCount} · 最近更新：${project.lastUpdatedAt}`,
          ],
          buttonLabel: "进入项目",
          value: this.buildCardActionValue(
            this.buildCardActionContext(input),
            `${BRIDGE_COMMAND_PREFIX} project switch ${project.projectKey}`,
          ),
          type: "primary",
        })),
        actions: this.buildSelectionCardActions(input),
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
    const visibleThreads = displayThreads.slice(0, MAX_CODEX_THREAD_SELECTION_ROWS);
    const isTruncated = visibleThreads.length < displayThreads.length;

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "选择线程",
        summaryLines: [
          `**项目**：${project.displayName}`,
          `**线程总数**：${threads.length}`,
          ...(isTruncated ? [`**已显示**：${visibleThreads.length} / ${threads.length}`] : []),
        ],
        sections: threads.length > 0
          ? []
          : [
              {
                title: "暂无线程",
                items: ["当前项目下没有可切换的 Codex 线程。"],
              },
            ],
        rows: visibleThreads.map(thread => ({
          title: formatCodexThreadListTitle(thread),
          lines: formatCodexThreadListLines(thread, threadById),
          buttonLabel: "切换到此线程",
          value: this.buildCardActionValue(
            this.buildCardActionContext(input),
            `${BRIDGE_COMMAND_PREFIX} thread switch ${thread.threadId}`,
          ),
          type: "primary",
        })),
        actions: this.buildSelectionCardActions(input),
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
    const surfaceInteractionState = this.getSurfaceInteractionState(input);
    const conversationItems = recentConversation.length > 0
      ? recentConversation.map(item => this.formatConversationPreviewItem(item))
      : ["暂未读取到可展示的最近对话。"];
    const model = this.buildStableSessionCardModel({
      projectLabel: project.displayName,
      threadLabel: thread.title,
      statusLabel: currentRun ? formatRuntimeStatusLabel(currentRun.status) : "空闲",
      scopeLabel: "当前线程",
      nextRunSettings: {
        model: effectivePreferences.model,
        reasoningEffort: effectivePreferences.reasoningEffort,
        speed: effectivePreferences.speed,
      },
      planModeEnabled: surfaceInteractionState.sessionMode === "plan_next_message",
      nextStepText: currentRun
        ? "当前任务仍在运行；如需查看细节可打开更多信息。"
        : surfaceInteractionState.sessionMode === "plan_next_message"
          ? "直接发送你的需求，我会按计划模式处理"
          : "直接发送下一条消息继续当前线程",
    });
    const summaryLines = [
      `**项目**：${model.projectLabel}`,
      `**线程**：${model.threadLabel}`,
      `**状态**：${model.statusLabel}`,
      `**作用范围**：${model.scopeLabel}`,
    ];
    const diagnostics = surfaceInteractionState.diagnosticsOpen
      ? this.buildStableSessionDiagnostics({
          input,
          projectLabel: project.displayName,
          projectPath: project.cwd,
          threadLabel: thread.title,
          threadId: thread.threadId,
          scopeLabel: model.scopeLabel,
          currentRun,
          effectivePreferences,
        })
      : undefined;

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前会话已就绪",
        summaryLines,
        stableMode: "session",
        planModeState: {
          enabled: model.planModeEnabled,
          singleUse: true,
        },
        context: actionContext,
        diagnostics,
        sections: [
          {
            title: "最近上下文",
            items: conversationItems,
          },
          {
            title: "下一步",
            items: [model.nextStepText],
          },
        ],
        extraElements: this.buildStableSessionPreferenceControlElements({
          context: actionContext,
          effectivePreferences,
        }),
        actions: [
          {
            id: "switch_thread",
            label: "切换线程",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
          {
            id: "more_info",
            label: "更多信息",
          },
        ],
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
    const surfaceInteractionState = this.getSurfaceInteractionState(input);
    const stableContextItems = contextItems.filter(item =>
      !item.startsWith("线程 ID：") &&
      !item.startsWith("群聊 ID：") &&
      !item.startsWith("话题 ID：")
    );
    const readableContext = this.resolveReadableContext(input, resolved, currentRun);
    const actionContext = this.buildCardActionContext(input);
    const model = this.buildStableSessionCardModel({
      projectLabel: readableContext.projectLabel ?? "未选择",
      threadLabel: readableContext.threadLabel ?? (this.isDmContext(input) ? "未选择" : "未绑定"),
      statusLabel: currentRun ? formatRuntimeStatusLabel(currentRun.status) : "空闲",
      scopeLabel: preferenceTarget.kind === "thread" ? "当前线程" : "当前会话入口",
      nextRunSettings: {
        model: effectivePreferences.model,
        reasoningEffort: effectivePreferences.reasoningEffort,
        speed: effectivePreferences.speed,
      },
      planModeEnabled: surfaceInteractionState.sessionMode === "plan_next_message",
      nextStepText: currentRun
        ? "当前任务仍在运行；如需查看细节可打开更多信息。"
        : surfaceInteractionState.sessionMode === "plan_next_message"
          ? "直接发送你的需求，我会按计划模式处理"
        : readableContext.threadId
          ? "直接发送下一条消息继续当前线程"
          : readableContext.projectLabel
            ? "选择已有线程，或直接发送消息创建新会话"
            : "先选择项目，再开始任务",
    });
    const summaryLines = [
      `**项目**：${model.projectLabel}`,
      `**线程**：${model.threadLabel}`,
      `**状态**：${model.statusLabel}`,
      `**作用范围**：${model.scopeLabel}`,
    ];
    const diagnostics = surfaceInteractionState.diagnosticsOpen
      ? this.buildStableSessionDiagnostics({
          input,
          projectLabel: model.projectLabel,
          projectPath: resolved.context.cwd,
          threadLabel: model.threadLabel,
          threadId: readableContext.threadId ?? resolved.threadId,
          scopeLabel: model.scopeLabel,
          currentRun,
          effectivePreferences,
        })
      : undefined;

    return {
      kind: "card",
      card: buildBridgeHubCard({
        title: "当前会话已就绪",
        summaryLines,
        stableMode: "session",
        planModeState: {
          enabled: model.planModeEnabled,
          singleUse: true,
        },
        context: actionContext,
        diagnostics,
        sections: [
          ...(stableContextItems.length > 0
            ? [{
                title: "最近上下文",
                items: stableContextItems,
              }]
            : []),
          {
            title: "下一步",
            items: [model.nextStepText],
          },
        ],
        extraElements: this.buildStableSessionPreferenceControlElements({
          context: actionContext,
          effectivePreferences,
        }),
        actions: [
          {
            id: "switch_thread",
            label: "切换线程",
            value: this.buildCardActionValue(actionContext, `${BRIDGE_COMMAND_PREFIX} thread list-current`),
          },
          {
            id: "more_info",
            label: "更多信息",
          },
        ],
      }),
    };
  }

  private buildRunStatusCardReply(
    input: BridgeMessageInput,
    resolved?: ResolvedContext,
    currentRun?: RuntimeRunSnapshot,
  ): BridgeReply {
    const actionContext = this.buildCardActionContext(input);
    const effectivePreferences = resolved
      ? this.resolveEffectiveCodexPreferences(input, resolved)
      : undefined;
    const summaryLines = ["**视图**：运行状态"];
    if (resolved?.root.id) {
      summaryLines.push(`**Root**：${resolved.root.id}`);
    }
    if (resolved) {
      summaryLines.push(...this.buildContextSummaryLines(input, resolved, currentRun));
      summaryLines.push(...this.buildCodexPreferenceSummaryLines(effectivePreferences!));
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
        extraElements: effectivePreferences
          ? this.buildCodexPreferenceControlElements({
              context: actionContext,
              effectivePreferences,
            })
          : undefined,
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
    return this.buildCurrentCodexSessionCardReply(input, project, thread, recentConversation);
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
    return this.dependencies.codexPreferences ?? getFallbackCodexPreferenceCatalog();
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
          ...this.normalizeSurfaceIdentity(input),
        },
      };
    }

    return {
      kind: "surface",
      surface: {
        ...this.normalizeSurfaceIdentity(input),
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
        speed: threadPreference.speed,
        source: "thread",
      };
    }

    const surfacePreference = this.dependencies.store.getCodexSurfacePreference({
      ...this.normalizeSurfaceIdentity(input),
    });
    if (surfacePreference) {
      return {
        model: surfacePreference.model,
        reasoningEffort: surfacePreference.reasoningEffort,
        speed: surfacePreference.speed,
        source: "surface",
      };
    }

    return {
      model: catalog.defaultModel,
      reasoningEffort: catalog.defaultReasoningEffort,
      speed: catalog.defaultSpeed,
      source: "default",
    };
  }

  private buildCodexPreferenceSummaryLines(
    effectivePreferences: EffectiveCodexPreferences,
  ): string[] {
    return [
      `**当前模型**：${getCodexModelLabel(effectivePreferences.model)}`,
      `**推理**：${getCodexReasoningLabel(effectivePreferences.reasoningEffort)}`,
      `**速度**：${getCodexSpeedLabel(effectivePreferences.speed)}`,
      `**设置范围**：${formatCodexPreferenceSourceLabel(effectivePreferences.source)}`,
    ];
  }

  private buildCodexPreferenceSectionItems(
    effectivePreferences: EffectiveCodexPreferences,
    target: CodexPreferenceTarget,
  ): string[] {
    return [
      `当前模型：${getCodexModelLabel(effectivePreferences.model)}`,
      `推理：${getCodexReasoningLabel(effectivePreferences.reasoningEffort)}`,
      `速度：${getCodexSpeedLabel(effectivePreferences.speed)}`,
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
                    content: getCodexModelLabel(model),
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
                content: "**推理**",
              },
              {
                tag: "select_static",
                initial_option: input.effectivePreferences.reasoningEffort,
                placeholder: {
                  tag: "plain_text",
                  content: "选择推理",
                },
                options: catalog.reasoningEffortOptions.map(reasoningEffort => ({
                  text: {
                    tag: "plain_text",
                    content: getCodexReasoningLabel(reasoningEffort),
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
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "markdown",
                content: "**速度**",
              },
              {
                tag: "select_static",
                initial_option: input.effectivePreferences.speed,
                placeholder: {
                  tag: "plain_text",
                  content: "选择速度",
                },
                options: catalog.speedOptions.map(speed => ({
                  text: {
                    tag: "plain_text",
                    content: getCodexSpeedLabel(speed),
                  },
                  value: speed,
                })),
                behaviors: [{
                  type: "callback",
                  value: this.buildCodexPreferenceActionValue(input.context, "set_codex_speed"),
                }],
              },
            ],
          },
        ],
      },
    ];
  }

  private buildStableSessionCardModel(input: StableSessionCardModel): StableSessionCardModel {
    return input;
  }

  private getSurfaceInteractionState(input: {
    channel: string;
    peerId: string;
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  }): SurfaceInteractionStateRecord {
    const normalizedSurface = this.normalizeSurfaceIdentity(input);
    return this.dependencies.store.getSurfaceInteractionState(normalizedSurface) ?? {
      ...normalizedSurface,
      sessionMode: "normal",
      diagnosticsOpen: false,
      updatedAt: new Date(0).toISOString(),
    };
  }

  private wrapPromptAsSingleUsePlanMessage(prompt: string): string {
    const trimmed = prompt.trim();
    return `/plan ${trimmed.length > 0 ? trimmed : prompt}`;
  }

  private buildStableSessionPreferenceControlElements(input: {
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
        content: "**下次任务设置**",
      },
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "default",
        columns: [
          {
            tag: "column",
            width: "auto",
            weight: 1,
            vertical_align: "center",
            elements: [{
              tag: "markdown",
              content: "**模型**",
            }],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 5,
            vertical_align: "center",
            elements: [{
              tag: "select_static",
              initial_option: input.effectivePreferences.model,
              placeholder: {
                tag: "plain_text",
                content: "选择模型",
              },
              options: catalog.modelOptions.map(model => ({
                text: {
                  tag: "plain_text",
                  content: getCodexModelLabel(model),
                },
                value: model,
              })),
              behaviors: [{
                type: "callback",
                value: this.buildCodexPreferenceActionValue(input.context, "set_codex_model"),
              }],
            }],
          },
        ],
      },
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "default",
        columns: [
          {
            tag: "column",
            width: "auto",
            weight: 1,
            vertical_align: "center",
            elements: [{
              tag: "markdown",
              content: "**推理**",
            }],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 2,
            vertical_align: "center",
            elements: [{
              tag: "select_static",
              initial_option: input.effectivePreferences.reasoningEffort,
              placeholder: {
                tag: "plain_text",
                content: "选择推理",
              },
              options: catalog.reasoningEffortOptions.map(reasoningEffort => ({
                text: {
                  tag: "plain_text",
                  content: getCodexReasoningLabel(reasoningEffort),
                },
                value: reasoningEffort,
              })),
              behaviors: [{
                type: "callback",
                value: this.buildCodexPreferenceActionValue(input.context, "set_reasoning_effort"),
              }],
            }],
          },
          {
            tag: "column",
            width: "auto",
            weight: 1,
            vertical_align: "center",
            elements: [{
              tag: "markdown",
              content: "**速度**",
            }],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 2,
            vertical_align: "center",
            elements: [{
              tag: "select_static",
              initial_option: input.effectivePreferences.speed,
              placeholder: {
                tag: "plain_text",
                content: "选择速度",
              },
              options: catalog.speedOptions.map(speed => ({
                text: {
                  tag: "plain_text",
                  content: getCodexSpeedLabel(speed),
                },
                value: speed,
              })),
              behaviors: [{
                type: "callback",
                value: this.buildCodexPreferenceActionValue(input.context, "set_codex_speed"),
              }],
            }],
          },
        ],
      },
    ];
  }

  private buildStableSessionDiagnostics(input: {
    input: BridgeMessageInput;
    projectLabel: string;
    projectPath: string;
    threadLabel: string;
    threadId?: string | null;
    scopeLabel: string;
    currentRun?: RuntimeRunSnapshot;
    effectivePreferences: EffectiveCodexPreferences;
  }): {
    contextRows: string[];
    recentRunRows: string[];
    nextRunRows: string[];
  } {
    return {
      contextRows: [
        `项目：${input.projectLabel}`,
        `项目路径：${input.projectPath}`,
        `线程：${input.threadLabel}`,
        ...(input.threadId ? [`threadId：${input.threadId}`] : []),
        `作用范围：${input.scopeLabel}`,
        `surface：${this.describeSurface(input.input)}`,
      ],
      recentRunRows: input.currentRun
        ? this.buildCurrentRunItems(input.currentRun, true)
        : ["当前没有最近运行。"],
      nextRunRows: [
        `设置：${getCodexModelLabel(input.effectivePreferences.model)} / ${getCodexReasoningLabel(input.effectivePreferences.reasoningEffort)} / ${getCodexSpeedLabel(input.effectivePreferences.speed)}`,
        `生效范围：${input.scopeLabel}`,
      ],
    };
  }

  private describeSurface(input: BridgeMessageInput): string {
    if (input.surfaceType === "thread") {
      return "feishu_thread";
    }

    if (this.isGroupMainlineContext(input)) {
      return "feishu_chat";
    }

    return "feishu_dm";
  }

  private buildSelectionCardActions(input: BridgeMessageInput): Array<{
    label: string;
    value: Record<string, unknown>;
    type?: "default" | "primary" | "danger";
  }> {
    const hasCurrentSession = this.isDmContext(input)
      ? Boolean(this.lookupDmCodexSelection(input) || this.lookupDmSelectedProject(input))
      : Boolean(input.chatId || input.surfaceType === "thread");

    return [
      {
        label: hasCurrentSession ? "返回当前会话" : "返回导航",
        value: this.buildCardActionValue(
          this.buildCardActionContext(input),
          hasCurrentSession ? `${BRIDGE_COMMAND_PREFIX} session` : BRIDGE_COMMAND_PREFIX,
        ),
      },
      {
        label: "新会话",
        value: this.buildCardActionValue(this.buildCardActionContext(input), `${BRIDGE_COMMAND_PREFIX} new`),
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
      items.push(`模型：${getCodexModelLabel(currentRun.model)}`);
    }
    if (currentRun.reasoningEffort) {
      items.push(`推理：${getCodexReasoningLabel(currentRun.reasoningEffort)}`);
    }
    if (currentRun.speed) {
      items.push(`速度：${getCodexSpeedLabel(currentRun.speed)}`);
    }
    items.push(`摘要：${normalizeMarkdownToPlainText(currentRun.latestPreview)}`);
    return items;
  }

  private formatConversationPreviewItem(item: CodexCatalogConversationItem): string {
    const visibleText = item.role === "assistant"
      ? buildFeishuVisibleAssistantText(item.text)
      : item.text;
    const normalizedText = normalizeMarkdownToPlainText(visibleText).trim() || "（无可展示内容）";
    return `${item.role === "user" ? "用户" : "助手"}：${normalizedText}`;
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
    } else if (this.isGroupMainlineContext(input) && input.chatId) {
      const projectChat = this.dependencies.store.getProjectChatByChatId(input.chatId);
      if (projectChat) {
        const project = this.dependencies.store.getProject(projectChat.projectId);
        projectLabel = project?.name ?? projectChat.projectId;
      }
    }

    const deliveryChatId = currentRun?.deliveryChatId
      ?? resolved?.deliveryChatId
      ?? (this.isGroupMainlineContext(input) ? input.chatId ?? null : null);
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
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  } {
    return {
      chatType: input.chatType,
      chatId: input.chatId,
      surfaceType: input.surfaceType,
      surfaceRef: input.surfaceRef,
    };
  }

  private normalizeSurfaceIdentity(input: {
    channel: string;
    peerId: string;
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
    surfaceRef?: string;
  }): {
    channel: string;
    peerId: string;
    chatId: string | null;
    surfaceType: "thread" | null;
    surfaceRef: string | null;
  } {
    const isDm = this.isDmContext(input);
    return {
      channel: input.channel,
      peerId: input.peerId,
      chatId: isDm ? null : input.chatId ?? null,
      surfaceType: input.surfaceType ?? null,
      surfaceRef: input.surfaceRef ?? null,
    };
  }

  private isDmContext(input: {
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
  }): boolean {
    if (input.surfaceType === "thread") {
      return false;
    }

    if (input.chatType === "p2p") {
      return true;
    }

    if (input.chatType === "group") {
      return false;
    }

    return !input.chatId;
  }

  private isGroupMainlineContext(input: {
    chatType?: "p2p" | "group";
    chatId?: string;
    surfaceType?: "thread";
  }): boolean {
    return input.surfaceType !== "thread" && !this.isDmContext(input) && Boolean(input.chatId);
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

    const selection = this.lookupCatalogThreadSelection(binding.codexThreadId);
    if (!selection) {
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
      } else if (selectedCatalogProject.projectKey !== selection.project.projectKey) {
        this.dependencies.store.clearCodexWindowBinding(input.channel, input.peerId);
        return undefined;
      }
    }

    return {
      ...selection,
      binding,
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

  private lookupCatalogThreadSelection(threadId: string): DmCodexCatalogSelection | undefined {
    if (!this.dependencies.codexCatalog) {
      return undefined;
    }

    const thread = this.dependencies.codexCatalog.getThread(threadId);
    if (!thread) {
      return undefined;
    }

    const project = this.dependencies.codexCatalog.getProject(thread.projectKey, {
      includeArchived: true,
    });
    if (!project) {
      return undefined;
    }

    return {
      binding: {
        codexThreadId: thread.threadId,
      },
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

  private resolveDesktopCompletionProjectGroupRoute(
    threadId: string,
  ): DesktopCompletionRouteTarget | undefined {
    const catalogThread = this.dependencies.codexCatalog?.getThread(threadId);
    if (!catalogThread) {
      return undefined;
    }

    const bindings = this.listCatalogProjectChatBindings()
      .filter(binding => Boolean(binding.chatId));
    const exactProjectBinding = bindings.find(binding => binding.projectId === catalogThread.projectKey);
    if (exactProjectBinding?.chatId) {
      return {
        mode: "project_group",
        chatId: exactProjectBinding.chatId,
      };
    }

    const cwdMatches = bindings.filter(binding =>
      normalizePathKey(binding.cwd) === normalizePathKey(catalogThread.cwd)
    );
    if (cwdMatches.length !== 1 || !cwdMatches[0]?.chatId) {
      return undefined;
    }

    return {
      mode: "project_group",
      chatId: cwdMatches[0].chatId,
    };
  }

  private resolveDesktopCompletionDmPeer(threadId: string): string | undefined {
    return this.dependencies.store.getPreferredCodexWindowBindingForThread("feishu", threadId)?.peerId
      ?? this.dependencies.store.getUniqueDmPeer("feishu");
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
      speed?: CodexSpeed;
    } = {
      cwd: resolved.context.cwd,
      prompt: buildNativeThreadBootstrapPrompt(resolved.context.threadTitle ?? prompt),
    };
    if (effectivePreferences.source !== "default") {
      createThreadInput.model = effectivePreferences.model;
      createThreadInput.reasoningEffort = effectivePreferences.reasoningEffort;
    }
    if (effectivePreferences.source !== "default" || effectivePreferences.speed === "fast") {
      createThreadInput.speed = effectivePreferences.speed;
    }
    const created = await this.dependencies.runner.createThread(createThreadInput);
    this.dependencies.store.upsertCodexThreadPreference({
      threadId: created.threadId,
      model: effectivePreferences.model,
      reasoningEffort: effectivePreferences.reasoningEffort,
      speed: effectivePreferences.speed,
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
    } else if (this.isGroupMainlineContext(input) && input.chatId) {
      this.dependencies.store.bindCodexChat({
        channel: input.channel,
        chatId: input.chatId,
        codexThreadId: created.threadId,
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

  private bindDmToCodexThread(input: {
    channel: string;
    peerId: string;
    thread: CodexCatalogThread;
  }): void {
    this.dependencies.store.bindCodexWindow({
      channel: input.channel,
      peerId: input.peerId,
      codexThreadId: input.thread.threadId,
    });
    this.dependencies.store.setCodexProjectSelection({
      channel: input.channel,
      peerId: input.peerId,
      projectKey: input.thread.projectKey,
    });
  }

  private bindGroupChatToCodexThread(input: {
    channel: string;
    chatId: string;
    thread: CodexCatalogThread;
  }): void {
    this.dependencies.store.bindCodexChat({
      channel: input.channel,
      chatId: input.chatId,
      codexThreadId: input.thread.threadId,
    });
  }

  private lookupGroupChatCodexSelection(
    channel: string,
    projectChat: {
      projectId: string;
      chatId: string;
    },
  ): DmCodexCatalogSelection | undefined {
    const binding = this.dependencies.store.getCodexChatBinding(channel, projectChat.chatId);
    if (!binding) {
      return undefined;
    }

    const selection = this.lookupCatalogThreadSelection(binding.codexThreadId);
    if (!selection || !this.matchesProjectChatSelection(projectChat.projectId, selection.thread)) {
      this.dependencies.store.clearCodexChatBinding(channel, projectChat.chatId);
      return undefined;
    }

    return selection;
  }

  private matchesProjectChatSelection(projectId: string, thread: CodexCatalogThread): boolean {
    const projectRecord = this.dependencies.store.getProject(projectId);
    if (!projectRecord) {
      return false;
    }

    return normalizePathKey(projectRecord.cwd) === normalizePathKey(thread.cwd);
  }

  private buildCardActionValue(
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
    command: string,
  ): Record<string, unknown> {
    return buildSharedCommandActionValue({
      command,
      context,
    });
  }

  private buildCodexPreferenceActionValue(
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
    bridgeAction: "set_codex_model" | "set_reasoning_effort" | "set_codex_speed",
  ): Record<string, unknown> {
    return buildSharedPreferenceActionValue(context, bridgeAction);
  }

  private buildPlanActionValue(
    context: {
      chatId?: string;
      surfaceType?: "thread";
      surfaceRef?: string;
    },
  ): Record<string, unknown> {
    return buildPlanModeToggleActionValue(context);
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
  const title = truncateCardLineText(normalizeCardLineText(thread.title), MAX_CODEX_THREAD_LIST_TITLE_CHARS);
  return sourceInfo.kind === "subagent" ? `└ ${title}` : title;
}

function formatCodexThreadListLines(
  thread: CodexCatalogThread,
  threadById: Map<string, CodexCatalogThread>,
): string[] {
  const sourceInfo = getCodexThreadSourceInfo(thread);

  if (sourceInfo.kind === "subagent") {
    return [
      truncateCardLineText(
        `子 agent · 父线程：${formatParentThreadLabel(sourceInfo.parentThreadId, threadById)}${formatSubagentDepth(sourceInfo)}`,
        MAX_CODEX_THREAD_LIST_LINE_CHARS,
      ),
      ...(formatSubagentIdentity(sourceInfo) !== "未命名"
        ? [truncateCardLineText(`身份：${normalizeCardLineText(formatSubagentIdentity(sourceInfo))}`, MAX_CODEX_THREAD_LIST_LINE_CHARS)]
        : []),
      `最近更新：${thread.updatedAt}`,
    ];
  }

  return [
    "主线程",
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

  return `${truncateCardLineText(normalizeCardLineText(parent.title), 32)}（${formatThreadIdReference(parent.threadId)}）`;
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

function normalizeCardLineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

function buildDesktopCompletionDmTarget(input: {
  allowlist: string[];
  desktopOwnerOpenId?: string;
  inferredDmPeerId?: string;
}): DesktopCompletionRouteTarget {
  const explicitOwnerOpenId = input.desktopOwnerOpenId?.trim();
  if (explicitOwnerOpenId) {
    return {
      mode: "dm",
      peerId: explicitOwnerOpenId,
    };
  }

  if (input.allowlist.length === 1 && input.allowlist[0]) {
    return {
      mode: "dm",
      peerId: input.allowlist[0],
    };
  }

  const inferredDmPeerId = input.inferredDmPeerId?.trim();
  if (inferredDmPeerId) {
    return {
      mode: "dm",
      peerId: inferredDmPeerId,
    };
  }

  throw new Error("FEISHU_DESKTOP_OWNER_OPEN_ID_REQUIRED_FOR_DM_FALLBACK");
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
