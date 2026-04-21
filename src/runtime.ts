import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { buildApp } from "./app.js";
import { BridgeService } from "./bridge-service.js";
import { CodexCliRunner } from "./codex-cli-runner.js";
import { observeCodexDesktopCompletion } from "./codex-desktop-completion-observer.js";
import { resolveCodexPreferenceCatalog } from "./codex-preferences.js";
import { CodexSqliteCatalog } from "./codex-sqlite-catalog.js";
import type { BridgeConfig } from "./config.js";
import {
  DesktopCompletionNotifier,
  type DesktopCompletionDeliveryTarget,
} from "./desktop-completion-notifier.js";
import { FeishuAdapter, type FeishuApiClientLike, type FeishuEnvelope } from "./feishu-adapter.js";
import { FeishuApiClient } from "./feishu-api-client.js";
import { FeishuCardActionService } from "./feishu-card-action-service.js";
import { FeishuWsClient } from "./feishu-ws-client.js";
import { ProjectThreadService } from "./project-thread-service.js";
import { RunWorkerManager } from "./run-worker-manager.js";
import { resolveExecutable } from "./executable.js";
import type {
  CodexCatalogConversationItem,
  CodexCatalogProject,
  CodexCatalogThread,
} from "./types.js";
import { SessionStore } from "./workspace/session-store.js";

interface WsClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ThreadReapRunnerLike {
  close(context: { sessionName: string; cwd: string }): Promise<void>;
}

interface CodexCatalogLike {
  listProjects(options?: { includeArchived?: boolean }): CodexCatalogProject[];
  getProject(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogProject | undefined;
  listThreads(projectKey: string, options?: { includeArchived?: boolean }): CodexCatalogThread[];
  getThread(threadId: string): CodexCatalogThread | undefined;
  listRecentConversation(threadId: string, limit?: number): CodexCatalogConversationItem[];
}

const DEFAULT_DESKTOP_COMPLETION_POLL_INTERVAL_MS = 15_000;

export async function createRuntime(
  config: BridgeConfig,
  overrides?: {
    createApiClient?: (config: BridgeConfig) => FeishuApiClientLike;
    createWsClient?: (
      config: BridgeConfig,
      adapter: FeishuAdapter,
      cardActionService: FeishuCardActionService,
      logger?: Logger,
    ) => WsClientLike;
    createCodexCatalog?: () => CodexCatalogLike | undefined;
    desktopCompletionPollIntervalMs?: number;
    logger?: Logger;
  },
) {
  mkdirSync(path.dirname(config.storage.sqlitePath), { recursive: true });
  mkdirSync(config.storage.logDir, { recursive: true });

  const store = new SessionStore(config.storage.sqlitePath);
  store.upsertRoot(config.root);
  store.purgeOldObservabilityEvents();
  store.recoverInterruptedRuns();

  const resolvedCodexCommand =
    resolveExecutable(config.codex.command, { cwd: process.cwd() }) ?? config.codex.command;
  const runner = new CodexCliRunner(resolvedCodexCommand);
  const workerManager = new RunWorkerManager({
    maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
  });
  const codexPreferences = resolveCodexPreferenceCatalog(config.codex);
  let codexCatalog: CodexCatalogLike | undefined;
  try {
    codexCatalog = overrides?.createCodexCatalog?.() ?? new CodexSqliteCatalog();
  } catch {
    codexCatalog = undefined;
  }
  const apiClient =
    overrides?.createApiClient?.(config) ?? createDefaultApiClient(config, overrides?.logger);
  const projectThreadService = new ProjectThreadService({
    apiClient,
    runner,
    store,
  });
  const bridgeService = new BridgeService({
    store,
    runner,
    workerManager,
    projectThreadService,
    codexCatalog,
    codexPreferences,
  });
  const adapter = new FeishuAdapter({
    allowlist: config.feishu.allowlist,
    bridgeService,
    apiClient,
    pendingAssetStore: store,
    requireGroupMention: config.feishu.requireGroupMention,
    logger: overrides?.logger,
  });
  const cardActionService = new FeishuCardActionService({
    bridgeService,
    apiClient,
    logger: overrides?.logger,
  });
  const wsClient =
    overrides?.createWsClient?.(config, adapter, cardActionService, overrides?.logger) ??
    createDefaultWsClient(config, adapter, cardActionService, overrides?.logger);
  const desktopCompletionNotifier = new DesktopCompletionNotifier({
    apiClient,
    store,
    codexCatalog,
  });
  const getRuntimeSnapshot = () => workerManager.getRuntimeSnapshot();

  const app = buildApp({
    readinessProbe: async () => runner.checkHealth(),
    observability: {
      getOverview: async () => {
        const overview = store.getOverview();
        const runtimeSnapshot = getRuntimeSnapshot();

        return {
          ...overview,
          activeRuns: runtimeSnapshot.activeCount,
          queuedRuns: runtimeSnapshot.queuedCount,
          cancelingRuns: runtimeSnapshot.cancelingCount,
          longestActiveMs: runtimeSnapshot.activeRuns.reduce(
            (maxMs, run) => Math.max(maxMs, run.elapsedMs),
            0,
          ),
          longestQueuedMs: runtimeSnapshot.queuedRuns.reduce(
            (maxMs, run) => Math.max(maxMs, run.waitMs),
            0,
          ),
        };
      },
      listRuns: async filters => store.listRuns(filters),
      getRun: async runId => store.getRun(runId),
      listRunEvents: async runId => store.listRunEvents(runId),
      listSessionSnapshots: async () => store.listSessionSnapshots(),
      listProjects: async () => store.listProjects(),
      listProjectThreads: async projectId => store.listProjectThreads(projectId),
      getThread: async threadId => store.getThread(threadId),
      listThreadRuns: async threadId => store.listThreadRuns(threadId),
      getRuntimeSnapshot,
      cancelRun: async runId => {
        const runtimeSnapshot = getRuntimeSnapshot();
        const queuedRun = runtimeSnapshot.queuedRuns.find(run => run.runId === runId);
        if (queuedRun) {
          store.markRunCancelRequested({
            runId,
            requestedBy: "ops",
            source: "ops",
          });
          store.appendRunEvent({
            runId,
            source: "system",
            status: "canceling",
            stage: "canceling",
            preview: "[ca] cancel requested",
          });
        }

        return workerManager.cancelRun(runId, {
          requestedBy: "ops",
          source: "ops",
        });
      },
    },
  });

  let idleReaper: NodeJS.Timeout | undefined;
  let desktopCompletionPoller: NodeJS.Timeout | undefined;
  let desktopCompletionPollInFlight = false;

  const runDesktopCompletionPoll = async () => {
    if (desktopCompletionPollInFlight) {
      return;
    }

    desktopCompletionPollInFlight = true;
    try {
      await pollDesktopCompletionNotifications({
        store,
        codexCatalog,
        bridgeService,
        notifier: desktopCompletionNotifier,
        allowlist: config.feishu.allowlist,
        desktopOwnerOpenId: config.feishu.desktopOwnerOpenId,
      });
    } catch (error) {
      overrides?.logger?.info?.(
        `[ca] desktop completion poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      desktopCompletionPollInFlight = false;
    }
  };

  return {
    app,
    store,
    runner,
    bridgeService,
    adapter,
    wsClient,
    async start() {
      await app.listen({
        host: config.server.host,
        port: config.server.port,
      });
      await wsClient.start();
      idleReaper = setInterval(() => {
        void runRuntimeMaintenance({
          store,
          runner,
          ttlHours: config.root.idleTtlHours,
        });
      }, 5 * 60 * 1000);
      desktopCompletionPoller = setInterval(() => {
        void runDesktopCompletionPoll();
      }, overrides?.desktopCompletionPollIntervalMs ?? DEFAULT_DESKTOP_COMPLETION_POLL_INTERVAL_MS);
      void runDesktopCompletionPoll();
    },
    async stop() {
      if (idleReaper) {
        clearInterval(idleReaper);
      }
      if (desktopCompletionPoller) {
        clearInterval(desktopCompletionPoller);
      }
      await wsClient.stop();
      await app.close();
      store.close();
    },
  };
}

export async function pollDesktopCompletionNotifications(input: {
  store: SessionStore;
  codexCatalog?: CodexCatalogLike;
  bridgeService: Pick<BridgeService, "resolveDesktopCompletionRoute">;
  notifier: Pick<DesktopCompletionNotifier, "publish">;
  allowlist: string[];
  desktopOwnerOpenId?: string;
}): Promise<void> {
  if (!input.codexCatalog) {
    return;
  }

  for (const thread of listObservedCodexThreads(input.codexCatalog)) {
    if (!thread.rolloutPath || !existsSync(thread.rolloutPath)) {
      continue;
    }

    const rolloutMtime = statSync(thread.rolloutPath).mtime.toISOString();
    const existingState = input.store.getCodexThreadWatchState(thread.threadId);
    if (!existingState || existingState.rolloutPath !== thread.rolloutPath) {
      const bootstrap = observeCodexDesktopCompletion({
        threadId: thread.threadId,
        rolloutPath: thread.rolloutPath,
        offset: 0,
      });
      input.store.upsertCodexThreadWatchState({
        threadId: thread.threadId,
        rolloutPath: thread.rolloutPath,
        rolloutMtime,
        lastReadOffset: bootstrap.nextOffset,
        lastCompletionKey: bootstrap.completion?.completionKey ?? null,
        lastNotifiedCompletionKey: bootstrap.completion?.completionKey ?? null,
      });
      continue;
    }

    const observed = observeCodexDesktopCompletion({
      threadId: thread.threadId,
      rolloutPath: thread.rolloutPath,
      offset: existingState.lastReadOffset,
    });
    input.store.upsertCodexThreadWatchState({
      threadId: thread.threadId,
      rolloutPath: thread.rolloutPath,
      rolloutMtime,
      lastReadOffset: observed.nextOffset,
      ...(observed.completion
        ? {
            lastCompletionKey: observed.completion.completionKey,
          }
        : {}),
    });

    if (!observed.completion || observed.completion.completionKey === existingState.lastNotifiedCompletionKey) {
      continue;
    }

    const routeTarget = input.bridgeService.resolveDesktopCompletionRoute({
      threadId: thread.threadId,
      allowlist: input.allowlist,
      desktopOwnerOpenId: input.desktopOwnerOpenId,
    });
    await input.notifier.publish({
      completion: observed.completion,
      target: normalizeDesktopCompletionDeliveryTarget(routeTarget),
    });
  }
}

export async function runRuntimeMaintenance(input: {
  store: SessionStore;
  runner: ThreadReapRunnerLike;
  ttlHours: number;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await reapIdleThreads({
    store: input.store,
    runner: input.runner,
    ttlHours: input.ttlHours,
    now,
  });
  expireStalePendingBridgeAssets({
    store: input.store,
    ttlHours: input.ttlHours,
    now,
  });
}

export async function reapIdleThreads(input: {
  store: SessionStore;
  runner: ThreadReapRunnerLike;
  ttlHours: number;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - input.ttlHours * 60 * 60 * 1000).toISOString();
  const reapableThreads = input.store.listReapableThreads(cutoffIso);

  for (const thread of reapableThreads) {
    void input.runner;
    void thread.cwd;
    void thread.sessionName;
    input.store.updateCodexThreadState({
      threadId: thread.threadId,
      status: "closed",
      lastActivityAt: now.toISOString(),
    });
  }
}

export function expireStalePendingBridgeAssets(input: {
  store: SessionStore;
  ttlHours: number;
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - input.ttlHours * 60 * 60 * 1000).toISOString();
  return input.store.expirePendingBridgeAssets(cutoffIso);
}

function createDefaultApiClient(config: BridgeConfig, logger?: Logger) {
  return new FeishuApiClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    apiBaseUrl: config.feishu.apiBaseUrl,
  }, undefined, {
    logger,
  });
}

function createDefaultWsClient(
  config: BridgeConfig,
  adapter: FeishuAdapter,
  cardActionService: FeishuCardActionService,
  logger?: Logger,
): WsClientLike {
  return new FeishuWsClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    onEnvelope: envelope => adapter.handleEnvelope(envelope as FeishuEnvelope),
    onCardAction: event => cardActionService.handleAction(event as any),
    encryptKey: config.feishu.encryptKey || undefined,
    reconnectCount: config.feishu.reconnectCount,
    reconnectIntervalMs: config.feishu.reconnectIntervalSeconds * 1000,
    reconnectNonceMs: config.feishu.reconnectNonceSeconds * 1000,
    logger,
  });
}

function listObservedCodexThreads(codexCatalog: CodexCatalogLike): CodexCatalogThread[] {
  const threadsById = new Map<string, CodexCatalogThread>();
  for (const project of codexCatalog.listProjects({ includeArchived: false })) {
    for (const thread of codexCatalog.listThreads(project.projectKey, { includeArchived: false })) {
      const existing = threadsById.get(thread.threadId);
      if (!existing || thread.updatedAt >= existing.updatedAt) {
        threadsById.set(thread.threadId, thread);
      }
    }
  }

  return [...threadsById.values()].sort((left, right) => left.threadId.localeCompare(right.threadId));
}

function normalizeDesktopCompletionDeliveryTarget(
  target: {
    mode: "thread" | "project_group" | "dm";
    peerId?: string;
    chatId?: string;
    surfaceRef?: string;
    anchorMessageId?: string;
  },
): DesktopCompletionDeliveryTarget {
  switch (target.mode) {
    case "dm":
      if (!target.peerId) {
        throw new Error("FEISHU_DESKTOP_DM_TARGET_PEER_REQUIRED");
      }
      return {
        mode: "dm",
        peerId: target.peerId,
      };
    case "project_group":
      if (!target.chatId) {
        throw new Error("FEISHU_DESKTOP_GROUP_TARGET_CHAT_REQUIRED");
      }
      return {
        mode: "project_group",
        chatId: target.chatId,
      };
    case "thread":
      if (!target.chatId || !target.surfaceRef || !target.anchorMessageId) {
        throw new Error("FEISHU_DESKTOP_THREAD_TARGET_CONTEXT_REQUIRED");
      }
      return {
        mode: "thread",
        chatId: target.chatId,
        surfaceRef: target.surfaceRef,
        anchorMessageId: target.anchorMessageId,
      };
  }
}
