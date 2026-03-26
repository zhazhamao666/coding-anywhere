import { mkdirSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { AcpxRunner } from "./acpx-runner.js";
import { buildApp } from "./app.js";
import { BridgeService } from "./bridge-service.js";
import { CodexSqliteCatalog } from "./codex-sqlite-catalog.js";
import type { BridgeConfig } from "./config.js";
import { FeishuAdapter, type FeishuApiClientLike, type FeishuEnvelope } from "./feishu-adapter.js";
import { FeishuApiClient } from "./feishu-api-client.js";
import { FeishuCardActionService } from "./feishu-card-action-service.js";
import { FeishuWsClient } from "./feishu-ws-client.js";
import { ProjectThreadService } from "./project-thread-service.js";
import { RunWorkerManager } from "./run-worker-manager.js";
import { resolveExecutable } from "./executable.js";
import { SessionStore } from "./workspace/session-store.js";

interface WsClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ThreadReapRunnerLike {
  close(context: { sessionName: string; cwd: string }): Promise<void>;
}

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
    logger?: Logger;
  },
) {
  mkdirSync(path.dirname(config.storage.sqlitePath), { recursive: true });
  mkdirSync(config.storage.logDir, { recursive: true });

  const store = new SessionStore(config.storage.sqlitePath);
  store.upsertRoot(config.root);
  store.purgeOldObservabilityEvents();

  const resolvedAcpxCommand =
    resolveExecutable(config.acpx.command, { cwd: process.cwd() }) ?? config.acpx.command;
  const resolvedCodexCommand =
    resolveExecutable("codex", { cwd: process.cwd() }) ?? "codex";
  const runner = new AcpxRunner(resolvedAcpxCommand, config.acpx.agent, resolvedCodexCommand);
  const workerManager = new RunWorkerManager({
    maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
  });
  let codexCatalog: CodexSqliteCatalog | undefined;
  try {
    codexCatalog = new CodexSqliteCatalog();
  } catch {
    codexCatalog = undefined;
  }
  const apiClient =
    overrides?.createApiClient?.(config) ?? createDefaultApiClient(config);
  const projectThreadService = new ProjectThreadService({
    apiClient,
    store,
  });
  const bridgeService = new BridgeService({
    store,
    runner,
    workerManager,
    projectThreadService,
    codexCatalog,
  });
  const adapter = new FeishuAdapter({
    allowlist: config.feishu.allowlist,
    bridgeService,
    apiClient,
    requireGroupMention: config.feishu.requireGroupMention,
  });
  const cardActionService = new FeishuCardActionService({
    bridgeService,
    logger: overrides?.logger,
  });
  const wsClient =
    overrides?.createWsClient?.(config, adapter, cardActionService, overrides?.logger) ??
    createDefaultWsClient(config, adapter, cardActionService, overrides?.logger);

  const app = buildApp({
    readinessProbe: async () => runner.checkHealth(),
    observability: {
      getOverview: async () => store.getOverview(),
      listRuns: async filters => store.listRuns(filters),
      getRun: async runId => store.getRun(runId),
      listRunEvents: async runId => store.listRunEvents(runId),
      listSessionSnapshots: async () => store.listSessionSnapshots(),
      listProjects: async () => store.listProjects(),
      listProjectThreads: async projectId => store.listProjectThreads(projectId),
      getThread: async threadId => store.getThread(threadId),
      listThreadRuns: async threadId => store.listThreadRuns(threadId),
    },
  });

  let idleReaper: NodeJS.Timeout | undefined;

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
        void reapIdleThreads({
          store,
          runner,
          ttlHours: config.root.idleTtlHours,
        });
      }, 5 * 60 * 1000);
    },
    async stop() {
      if (idleReaper) {
        clearInterval(idleReaper);
      }
      await wsClient.stop();
      await app.close();
      store.close();
    },
  };
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
    await input.runner.close({
      sessionName: thread.sessionName,
      cwd: thread.cwd,
    });
    input.store.updateCodexThreadState({
      threadId: thread.threadId,
      status: "closed",
      lastActivityAt: now.toISOString(),
    });
  }
}

function createDefaultApiClient(config: BridgeConfig) {
  return new FeishuApiClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    apiBaseUrl: config.feishu.apiBaseUrl,
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
    onCardAction: event =>
      cardActionService.handleAction(event as {
        open_id: string;
        tenant_key?: string;
        open_message_id?: string;
        token?: string;
        action?: {
          tag?: string;
          value?: {
            command?: string;
            chatId?: string;
            surfaceType?: "thread";
            surfaceRef?: string;
          };
        };
      }),
    encryptKey: config.feishu.encryptKey || undefined,
    logger,
  });
}
