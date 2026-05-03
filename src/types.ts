export type PermissionMode = "readonly" | "workspace-write" | "danger-full-access";

export interface PlanTodoItem {
  text: string;
  completed: boolean;
}

export interface PlanChoiceOption {
  choiceId: string;
  label: string;
  responseText: string;
  description?: string;
}

export interface PlanInteractionDraft {
  question: string;
  choices: PlanChoiceOption[];
}

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexSpeed = "standard" | "fast";

export interface CodexPreferenceCatalog {
  defaultModel: string;
  defaultReasoningEffort: CodexReasoningEffort;
  defaultSpeed: CodexSpeed;
  modelOptions: string[];
  reasoningEffortOptions: CodexReasoningEffort[];
  speedOptions: CodexSpeed[];
}

export interface CodexPreferenceRecord {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  speed: CodexSpeed;
  updatedAt: string;
}

export type SessionMode = "normal" | "plan_next_message";

export interface SurfaceInteractionStateRecord {
  channel: string;
  peerId: string;
  chatId: string | null;
  surfaceType: "thread" | null;
  surfaceRef: string | null;
  sessionMode: SessionMode;
  diagnosticsOpen: boolean;
  updatedAt: string;
}

export interface StableSessionCardModel {
  projectLabel: string;
  threadLabel: string;
  statusLabel: string;
  scopeLabel: string;
  nextRunSettings: {
    model: string;
    reasoningEffort: CodexReasoningEffort;
    speed: CodexSpeed;
  };
  planModeEnabled: boolean;
  nextStepText: string;
}

export type PendingPlanInteractionStatus = "pending" | "resolved" | "superseded";

export interface PendingPlanInteractionRecord extends PlanInteractionDraft {
  interactionId: string;
  runId: string;
  channel: string;
  peerId: string;
  chatId: string | null;
  surfaceType: "thread" | null;
  surfaceRef: string | null;
  threadId: string;
  sessionName: string;
  status: PendingPlanInteractionStatus;
  selectedChoiceId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type BridgeAssetStatus = "pending" | "consumed" | "failed" | "expired" | "sent";

export type BridgeAssetResourceType = "image" | "file";

export type BridgeAssetSemanticType = "markdown" | "drawio" | "generic";

export type BridgeAssetPresentation = "attachment" | "markdown_preview" | "drawio_with_preview";

export interface BridgeAssetPreview {
  format: "png" | "svg" | "pdf";
}

export interface BridgeAssetRecord {
  assetId: string;
  runId: string | null;
  channel: string;
  peerId: string;
  chatId: string | null;
  surfaceType: "thread" | null;
  surfaceRef: string | null;
  messageId: string;
  resourceType: BridgeAssetResourceType;
  resourceKey: string;
  localPath: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  status: BridgeAssetStatus;
  errorText: string | null;
  createdAt: string;
  updatedAt: string;
  consumedAt: string | null;
  failedAt: string | null;
  expiredAt: string | null;
}

export interface BridgeAssetDownloadResult {
  resourceKey: string;
  localPath: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
}

export interface RootProfile {
  id: string;
  name: string;
  cwd: string;
  repoRoot: string;
  branchPolicy: string;
  permissionMode: PermissionMode;
  envAllowlist: string[];
  idleTtlHours: number;
}

export interface ThreadBinding {
  channel: string;
  peerId: string;
  sessionName: string;
  updatedAt: string;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  cwd: string;
  repoRoot: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectChatRecord {
  projectId: string;
  chatId: string;
  groupMessageType: string;
  title: string;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type CodexThreadStatus =
  | "provisioned"
  | "warm"
  | "running"
  | "idle"
  | "closed"
  | "archived";

export interface CodexThreadRecord {
  threadId: string;
  projectId: string;
  feishuThreadId: string;
  chatId: string;
  anchorMessageId: string;
  latestMessageId: string;
  sessionName: string;
  title: string;
  ownerOpenId: string;
  status?: CodexThreadStatus;
  lastRunId?: string | null;
  lastActivityAt?: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
}

export interface BridgeMessageInput {
  channel: string;
  peerId: string;
  text: string;
  chatType?: "p2p" | "group";
  chatId?: string;
  surfaceType?: "thread";
  surfaceRef?: string;
}

export interface DesktopCompletionCardInput {
  mode: "dm" | "project_group" | "thread";
  status?: "running" | "completed";
  projectName: string;
  threadTitle: string;
  startedAt?: string;
  completedAt?: string;
  summaryLines?: string[];
  resultText?: string;
  reminderText?: string;
  progressText?: string;
  planTodos?: PlanTodoItem[];
  commandCount?: number;
  threadId: string;
  chatId?: string;
  surfaceType?: "thread";
  surfaceRef?: string;
}

export interface CodexCatalogProject {
  projectKey: string;
  cwd: string;
  displayName: string;
  threadCount: number;
  activeThreadCount: number;
  lastUpdatedAt: string;
  gitBranch: string | null;
}

export interface CodexCatalogThreadSourceInfo {
  kind: "normal" | "subagent" | "unknown";
  label: string;
  parentThreadId?: string;
  depth?: number;
  agentNickname?: string;
  agentRole?: string;
}

export interface CodexCatalogThread {
  threadId: string;
  projectKey: string;
  cwd: string;
  displayName: string;
  title: string;
  source: string;
  sourceInfo?: CodexCatalogThreadSourceInfo;
  archived: boolean;
  updatedAt: string;
  createdAt: string;
  gitBranch: string | null;
  cliVersion: string;
  rolloutPath: string;
}

export interface CodexThreadWatchStateRecord {
  threadId: string;
  rolloutPath: string;
  rolloutMtime: string;
  lastReadOffset: number;
  lastCompletionKey: string | null;
  lastNotifiedCompletionKey: string | null;
  updatedAt: string;
}

export interface CodexDesktopDisplaySnapshot {
  lastHumanUserText?: string;
}

export interface CodexThreadDesktopNotificationStateRecord {
  threadId: string;
  activeRunKey: string | null;
  status: "running_notified" | "completed";
  startedAt: string | null;
  lastEventAt: string | null;
  messageId: string | null;
  deliveryMode: "dm" | "project_group" | "thread" | null;
  peerId: string | null;
  chatId: string | null;
  surfaceType: "thread" | null;
  surfaceRef: string | null;
  anchorMessageId: string | null;
  latestPublicMessage: string | null;
  planTodos: PlanTodoItem[] | null;
  commandCount: number;
  lastRenderHash: string | null;
  lastCompletionKey: string | null;
  updatedAt: string;
}

export interface CodexCatalogConversationItem {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface CodexWindowBinding {
  channel: string;
  peerId: string;
  codexThreadId: string;
  updatedAt: string;
}

export interface CodexChatBinding {
  channel: string;
  chatId: string;
  codexThreadId: string;
  updatedAt: string;
}

export interface CodexProjectSelection {
  channel: string;
  peerId: string;
  projectKey: string;
  updatedAt: string;
}

export type BridgeCommandName =
  | "help"
  | "hub"
  | "status"
  | "new"
  | "stop"
  | "session"
  | "logs"
  | "project"
  | "thread";

export interface BridgeCommand {
  name: BridgeCommandName;
  args: string[];
}

export type BridgeInput =
  | {
      kind: "prompt";
      prompt: string;
    }
  | {
      kind: "command";
      command: BridgeCommand;
    };

export type ProgressStatus =
  | "queued"
  | "preparing"
  | "canceling"
  | "running"
  | "tool_active"
  | "waiting"
  | "done"
  | "error"
  | "canceled";

export type BridgeLifecycleStage =
  | "received"
  | "resolving_context"
  | "ensuring_session"
  | "session_ready"
  | "submitting_prompt"
  | "waiting_first_event";

export type ProgressStage =
  | BridgeLifecycleStage
  | "canceling"
  | "tool_call"
  | "text"
  | "waiting"
  | "done"
  | "error"
  | "canceled";

export interface BridgeLifecycleEvent {
  type: "bridge_lifecycle";
  stage: BridgeLifecycleStage;
  content?: string;
  sessionName?: string;
}

export type RunnerEvent =
  | { type: "text"; content: string; planInteraction?: PlanInteractionDraft }
  | { type: "tool_call"; toolName: string; content: string }
  | { type: "done"; content?: string }
  | { type: "error"; content: string }
  | { type: "waiting"; content?: string; planTodos?: PlanTodoItem[] };

export type BridgeObservableEvent = BridgeLifecycleEvent | RunnerEvent;

export interface ProgressCardState {
  runId: string;
  rootName: string;
  sessionName?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  speed?: CodexSpeed;
  modelOptions?: string[];
  reasoningEffortOptions?: CodexReasoningEffort[];
  speedOptions?: CodexSpeed[];
  deliveryChatType?: "p2p" | "group" | null;
  deliveryChatId?: string | null;
  deliverySurfaceType?: "thread" | null;
  deliverySurfaceRef?: string | null;
  status: ProgressStatus;
  stage: ProgressStage;
  latestTool?: string;
  latestPublicMessage?: string;
  commandCount?: number;
  preview: string;
  planTodos?: PlanTodoItem[];
  planInteraction?: PendingPlanInteractionRecord;
  startedAt: number;
  elapsedMs: number;
}

export interface ObservabilityRun {
  runId: string;
  channel: string;
  peerId: string;
  projectId: string | null;
  threadId: string | null;
  deliveryChatId: string | null;
  deliverySurfaceType: "thread" | null;
  deliverySurfaceRef: string | null;
  sessionName: string;
  rootId: string;
  status: ProgressStatus;
  stage: ProgressStage;
  latestPreview: string;
  latestTool: string | null;
  errorText: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
  cancelSource: "feishu" | "ops" | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ObservabilityProjectSummary {
  projectId: string;
  name: string;
  chatId: string | null;
  threadCount: number;
  runningThreadCount: number;
  updatedAt: string;
}

export interface ObservabilityThreadSummary {
  threadId: string;
  projectId: string;
  chatId: string;
  feishuThreadId: string;
  title: string;
  sessionName: string;
  status: CodexThreadStatus;
  ownerOpenId: string;
  anchorMessageId: string;
  latestMessageId: string;
  lastRunId: string | null;
  lastActivityAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ReapableThread {
  threadId: string;
  projectId: string;
  sessionName: string;
  cwd: string;
  lastActivityAt: string;
}

export interface ObservabilityRunEvent {
  runId: string;
  seq: number;
  source: "bridge" | "runner" | "system";
  status: ProgressStatus;
  stage: ProgressStage;
  preview: string;
  toolName: string | null;
  createdAt: string;
}

export interface ObservabilityOverview {
  activeRuns: number;
  queuedRuns: number;
  cancelingRuns: number;
  totalRuns: number;
  completedRuns24h: number;
  failedRuns24h: number;
  longestActiveMs: number;
  longestQueuedMs: number;
  latestError: string | null;
  latestCancel: string | null;
  updatedAt: string | null;
}

export interface SessionSnapshot {
  channel: string;
  peerId: string;
  sessionName: string;
  latestRunId: string | null;
  latestRunStatus: ProgressStatus | null;
  latestRunStage: ProgressStage | null;
  updatedAt: string;
}

export interface ListRunsFilters {
  status?: ProgressStatus;
  peerId?: string;
  sessionName?: string;
  projectId?: string;
  threadId?: string;
  deliveryChatId?: string;
  activeOnly?: boolean;
  limit?: number;
}

export interface RuntimeRunSnapshot {
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
  waitMs: number;
  elapsedMs: number;
  cancelable: boolean;
}

export interface ActiveRunSnapshot extends RuntimeRunSnapshot {}

export interface QueueRunSnapshot extends RuntimeRunSnapshot {}

export interface RuntimeSnapshot {
  maxConcurrentRuns: number;
  activeCount: number;
  queuedCount: number;
  cancelingCount: number;
  locks: string[];
  activeRuns: ActiveRunSnapshot[];
  queuedRuns: QueueRunSnapshot[];
}

export type RunContext =
  | {
      targetKind: "codex_thread";
      threadId: string;
      sessionName: string;
      cwd: string;
    }
  | {
      targetKind: "new_codex_thread";
      sessionName: string;
      cwd: string;
      threadTitle?: string;
    };

export interface RunOutcome {
  events: RunnerEvent[];
  exitCode: number;
  threadId?: string;
}

export type BridgeReply =
  | { kind: "system"; text: string }
  | { kind: "progress"; text: string; status: ProgressStatus }
  | { kind: "card"; card: Record<string, unknown> }
  | { kind: "assistant"; text: string }
  | { kind: "image"; localPath: string; caption?: string }
  | {
      kind: "file";
      localPath: string;
      fileName?: string;
      caption?: string;
      mimeType?: string;
      fileSize?: number;
      semanticType?: BridgeAssetSemanticType;
      presentation?: BridgeAssetPresentation;
      preview?: BridgeAssetPreview;
    };
