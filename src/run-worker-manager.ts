import { ThreadRunGuard } from "./thread-run-guard.js";
import { RunCanceledError } from "./run-cancel-error.js";
import type {
  CodexReasoningEffort,
  CodexSpeed,
  ProgressStage,
  ProgressStatus,
  RuntimeSnapshot,
  RuntimeRunSnapshot,
} from "./types.js";

interface QueueItem {
  runId: string;
  concurrencyKey: string;
  worker: (control: RunControl) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  descriptor: RunDescriptor;
}

export class RunWorkerManager {
  private readonly guard = new ThreadRunGuard();
  private readonly queue: QueueItem[] = [];
  private readonly queuedByRunId = new Map<string, QueueItem>();
  private readonly activeByRunId = new Map<string, ActiveRunRecord>();
  private activeCount = 0;

  public constructor(
    private readonly config: {
      maxConcurrentRuns: number;
    },
  ) {}

  public schedule<T>(
    descriptor: RunDescriptor,
    worker: (control: RunControl) => Promise<T>,
  ): Promise<T> {
    const queuedAt = descriptor.startedAt ?? new Date().toISOString();
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        runId: descriptor.runId,
        concurrencyKey: descriptor.concurrencyKey,
        worker,
        resolve: value => {
          resolve(value as T);
        },
        reject,
        descriptor: {
          ...descriptor,
          startedAt: queuedAt,
        },
      };
      this.queue.push(item);
      this.queuedByRunId.set(item.runId, item);
      this.pumpQueue();
    });
  }

  public updateRunProgress(runId: string, input: {
    status: ProgressStatus;
    stage: ProgressStage;
    latestPreview: string;
    latestTool?: string | null;
  }): void {
    const active = this.activeByRunId.get(runId);
    if (!active) {
      return;
    }

    active.status = input.status;
    active.stage = input.stage;
    active.latestPreview = input.latestPreview;
    active.latestTool = input.latestTool ?? null;
  }

  public rebindRun(runId: string, input: {
    concurrencyKey?: string;
    projectId?: string | null;
    threadId?: string | null;
    deliveryChatId?: string | null;
    deliverySurfaceType?: "thread" | null;
    deliverySurfaceRef?: string | null;
    sessionName?: string;
  }): void {
    const active = this.activeByRunId.get(runId);
    if (active) {
      if (input.concurrencyKey && input.concurrencyKey !== active.concurrencyKey) {
        if (!this.guard.replace(active.concurrencyKey, input.concurrencyKey)) {
          throw new Error(`RUN_CONCURRENCY_KEY_CONFLICT:${input.concurrencyKey}`);
        }
        active.concurrencyKey = input.concurrencyKey;
      }
      if (input.projectId !== undefined) {
        active.projectId = input.projectId;
      }
      if (input.threadId !== undefined) {
        active.threadId = input.threadId;
      }
      if (input.deliveryChatId !== undefined) {
        active.deliveryChatId = input.deliveryChatId;
      }
      if (input.deliverySurfaceType !== undefined) {
        active.deliverySurfaceType = input.deliverySurfaceType;
      }
      if (input.deliverySurfaceRef !== undefined) {
        active.deliverySurfaceRef = input.deliverySurfaceRef;
      }
      if (input.sessionName) {
        active.sessionName = input.sessionName;
      }
      return;
    }

    const queued = this.queuedByRunId.get(runId);
    if (!queued) {
      return;
    }

    if (input.concurrencyKey) {
      queued.concurrencyKey = input.concurrencyKey;
      queued.descriptor.concurrencyKey = input.concurrencyKey;
    }
    if (input.projectId !== undefined) {
      queued.descriptor.projectId = input.projectId;
    }
    if (input.threadId !== undefined) {
      queued.descriptor.threadId = input.threadId;
    }
    if (input.deliveryChatId !== undefined) {
      queued.descriptor.deliveryChatId = input.deliveryChatId;
    }
    if (input.deliverySurfaceType !== undefined) {
      queued.descriptor.deliverySurfaceType = input.deliverySurfaceType;
    }
    if (input.deliverySurfaceRef !== undefined) {
      queued.descriptor.deliverySurfaceRef = input.deliverySurfaceRef;
    }
    if (input.sessionName) {
      queued.descriptor.sessionName = input.sessionName;
    }
  }

  public getRuntimeSnapshot(now = new Date()): RuntimeSnapshot {
    const activeRuns = Array.from(this.activeByRunId.values())
      .sort((left, right) => left.activeStartedAt.localeCompare(right.activeStartedAt))
      .map(record => toRuntimeRunSnapshot(record, now));
    const queuedRuns = this.queue
      .map(item => toRuntimeRunSnapshot({
        ...item.descriptor,
        startedAt: item.descriptor.startedAt ?? new Date().toISOString(),
        latestTool: item.descriptor.latestTool ?? null,
      }, now));

    return {
      maxConcurrentRuns: this.config.maxConcurrentRuns,
      activeCount: activeRuns.length,
      queuedCount: queuedRuns.length,
      cancelingCount: activeRuns.filter(run => run.status === "canceling").length,
      locks: activeRuns.map(run => run.concurrencyKey),
      activeRuns,
      queuedRuns,
    };
  }

  public getCurrentRun(concurrencyKey: string): RuntimeRunSnapshot | undefined {
    const active = Array.from(this.activeByRunId.values())
      .find(record => record.concurrencyKey === concurrencyKey);
    if (active) {
      return toRuntimeRunSnapshot(active, new Date());
    }

    const queued = this.queue.find(item => item.concurrencyKey === concurrencyKey);
    if (!queued) {
      return undefined;
    }

    return toRuntimeRunSnapshot({
      ...queued.descriptor,
      startedAt: queued.descriptor.startedAt ?? new Date().toISOString(),
      latestTool: queued.descriptor.latestTool ?? null,
    }, new Date());
  }

  public async cancelRun(runId: string, options?: {
    requestedBy?: string | null;
    source?: "feishu" | "ops";
  }): Promise<{
    accepted: boolean;
    runId: string;
    newStatus: ProgressStatus;
    message: string;
  }> {
    const queued = this.queuedByRunId.get(runId);
    if (queued) {
      this.queuedByRunId.delete(runId);
      const queueIndex = this.queue.findIndex(item => item.runId === runId);
      if (queueIndex >= 0) {
        this.queue.splice(queueIndex, 1);
      }
      queued.reject(new RunCanceledError());
      return {
        accepted: true,
        runId,
        newStatus: "canceled",
        message: "run canceled",
      };
    }

    const active = this.activeByRunId.get(runId);
    if (!active) {
      return {
        accepted: false,
        runId,
        newStatus: "error",
        message: "run not found",
      };
    }
    if (active.status === "canceling") {
      return {
        accepted: true,
        runId,
        newStatus: "canceling",
        message: "cancel requested",
      };
    }

    active.status = "canceling";
    active.stage = "canceling";
    active.cancelRequestedAt = new Date().toISOString();
    active.cancelRequestedBy = options?.requestedBy ?? null;
    active.cancelSource = options?.source ?? null;
    await active.onCancelRequested?.({
      requestedAt: active.cancelRequestedAt,
      requestedBy: active.cancelRequestedBy,
      source: active.cancelSource,
    });
    if (active.canceler) {
      await active.canceler();
    }

    return {
      accepted: true,
      runId,
      newStatus: "canceling",
      message: "cancel requested",
    };
  }

  private pumpQueue(): void {
    while (this.activeCount < this.config.maxConcurrentRuns) {
      const nextIndex = this.queue.findIndex(item => this.guard.tryAcquire(item.concurrencyKey));
      if (nextIndex === -1) {
        return;
      }

      const [next] = this.queue.splice(nextIndex, 1);
      if (!next) {
        return;
      }

      this.queuedByRunId.delete(next.runId);
      this.activeCount += 1;
      const activeRecord: ActiveRunRecord = {
        ...next.descriptor,
        projectId: next.descriptor.projectId ?? null,
        threadId: next.descriptor.threadId ?? null,
        deliveryChatId: next.descriptor.deliveryChatId ?? null,
        deliverySurfaceType: next.descriptor.deliverySurfaceType ?? null,
        deliverySurfaceRef: next.descriptor.deliverySurfaceRef ?? null,
        startedAt: next.descriptor.startedAt ?? new Date().toISOString(),
        activeStartedAt: new Date().toISOString(),
        model: next.descriptor.model ?? null,
        reasoningEffort: next.descriptor.reasoningEffort ?? null,
        speed: next.descriptor.speed ?? null,
        status: next.descriptor.status ?? "queued",
        stage: next.descriptor.stage ?? "received",
        latestTool: next.descriptor.latestTool ?? null,
      };
      this.activeByRunId.set(next.runId, activeRecord);
      void Promise.resolve()
        .then(() => next.worker({
          setCanceler: canceler => {
            activeRecord.canceler = canceler;
          },
          setOnCancelRequested: handler => {
            activeRecord.onCancelRequested = handler;
          },
        }))
        .then(result => {
          next.resolve(result);
        })
        .catch(error => {
          next.reject(error);
        })
        .finally(() => {
          this.activeCount -= 1;
          this.activeByRunId.delete(next.runId);
          this.guard.release(next.concurrencyKey);
          this.pumpQueue();
        });
    }
  }
}

export interface RunControl {
  setCanceler(canceler: () => Promise<void> | void): void;
  setOnCancelRequested(handler: (input: {
    requestedAt: string;
    requestedBy: string | null;
    source: "feishu" | "ops" | null;
  }) => Promise<void> | void): void;
}

export interface RunDescriptor {
  runId: string;
  concurrencyKey: string;
  channel: string;
  peerId: string;
  projectId?: string | null;
  threadId?: string | null;
  deliveryChatId?: string | null;
  deliverySurfaceType?: "thread" | null;
  deliverySurfaceRef?: string | null;
  sessionName: string;
  rootId: string;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  speed?: CodexSpeed | null;
  status?: ProgressStatus;
  stage?: ProgressStage;
  latestPreview: string;
  latestTool?: string | null;
  startedAt?: string;
}

interface ActiveRunRecord {
  runId: string;
  concurrencyKey: string;
  channel: string;
  peerId: string;
  projectId: string | null;
  threadId: string | null;
  deliveryChatId: string | null;
  deliverySurfaceType: "thread" | null;
  deliverySurfaceRef: string | null;
  sessionName: string;
  rootId: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  speed: CodexSpeed | null;
  status: ProgressStatus;
  stage: ProgressStage;
  latestPreview: string;
  latestTool: string | null;
  startedAt: string;
  activeStartedAt: string;
  cancelRequestedAt?: string;
  cancelRequestedBy?: string | null;
  cancelSource?: "feishu" | "ops" | null;
  canceler?: () => Promise<void> | void;
  onCancelRequested?: (input: {
    requestedAt: string;
    requestedBy: string | null;
    source: "feishu" | "ops" | null;
  }) => Promise<void> | void;
}

function toRuntimeRunSnapshot(
  record: {
    runId: string;
    concurrencyKey: string;
    channel: string;
    peerId: string;
    projectId?: string | null;
    threadId?: string | null;
    deliveryChatId?: string | null;
    deliverySurfaceType?: "thread" | null;
    deliverySurfaceRef?: string | null;
    sessionName: string;
    rootId: string;
    model?: string | null;
    reasoningEffort?: CodexReasoningEffort | null;
    speed?: CodexSpeed | null;
    status?: ProgressStatus;
    stage?: ProgressStage;
    latestPreview: string;
    latestTool?: string | null;
    startedAt: string;
  },
  now: Date,
): RuntimeRunSnapshot {
  const startedAtMs = new Date(record.startedAt).getTime();
  const waitMs = Math.max(0, now.getTime() - startedAtMs);

  return {
    runId: record.runId,
    concurrencyKey: record.concurrencyKey,
    channel: record.channel,
    peerId: record.peerId,
    projectId: record.projectId ?? null,
    threadId: record.threadId ?? null,
    deliveryChatId: record.deliveryChatId ?? null,
    deliverySurfaceType: record.deliverySurfaceType ?? null,
    deliverySurfaceRef: record.deliverySurfaceRef ?? null,
    sessionName: record.sessionName,
    rootId: record.rootId,
    model: record.model ?? null,
    reasoningEffort: record.reasoningEffort ?? null,
    speed: record.speed ?? null,
    status: record.status ?? "queued",
    stage: record.stage ?? "received",
    latestPreview: record.latestPreview,
    latestTool: record.latestTool ?? null,
    startedAt: record.startedAt,
    waitMs,
    elapsedMs: waitMs,
    cancelable: (record.status ?? "queued") !== "canceling",
  };
}
