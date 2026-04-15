import {
  EventDispatcher as LarkEventDispatcher,
  LoggerLevel,
  WSClient as LarkWSClient,
} from "@larksuiteoapi/node-sdk";

type EnvelopeHandler = (envelope: unknown) => Promise<void>;
type CardActionHandler = (event: NormalizedCardActionEvent) => Promise<unknown>;

interface NormalizedCardActionEvent {
  open_id: string;
  tenant_key?: string;
  open_message_id?: string;
  token?: string;
  action: {
    tag?: string;
    name?: string;
    value?: Record<string, unknown>;
    form_value?: Record<string, unknown>;
  };
}

interface BaseLoggerLike {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface EventDispatcherLike {
  register(handles: Record<string, (data: unknown) => Promise<unknown>>): EventDispatcherLike;
  invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown>;
}

interface WsClientLike {
  start(params: { eventDispatcher: { invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown> } }): Promise<void>;
  close(params?: { force?: boolean }): void;
}

interface WsSocketLike {
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
}

interface WsClientDiagnosticsLike {
  communicate?: () => void;
  wsConfig?: {
    getWSInstance?: () => WsSocketLike | null;
  };
}

interface FeishuSdkLike {
  EventDispatcher: new (params: any) => EventDispatcherLike;
  WSClient: new (params: any) => WsClientLike;
  LoggerLevel: {
    info: number;
  };
}

const defaultSdk: FeishuSdkLike = {
  EventDispatcher: LarkEventDispatcher,
  WSClient: LarkWSClient,
  LoggerLevel,
};

export class FeishuWsClient {
  private readonly dispatcher: {
    invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown>;
  };
  private readonly client: WsClientLike;
  private readonly instrumentedSockets = new WeakSet<object>();
  private transportConnectCount = 0;

  public constructor(
    private readonly dependencies: {
      appId: string;
      appSecret: string;
      onEnvelope: EnvelopeHandler;
      onCardAction?: CardActionHandler;
      encryptKey?: string;
      reconnectCount?: number;
      reconnectIntervalMs?: number;
      reconnectNonceMs?: number;
      logger?: BaseLoggerLike;
    },
    sdk: FeishuSdkLike = defaultSdk,
  ) {
    const sdkLogger = createSdkLogger(this.dependencies.logger);
    const eventDispatcher = new sdk.EventDispatcher({
      loggerLevel: sdk.LoggerLevel.info,
      logger: sdkLogger,
      encryptKey: this.dependencies.encryptKey,
    }).register({
      "im.message.receive_v1": data => {
        void this.dependencies.onEnvelope({
          event: data,
        }).catch(error => {
          this.dependencies.logger?.error?.(
            {
              error,
            },
            "feishu envelope processing failed",
          );
        });

        return Promise.resolve();
      },
    });

    this.dispatcher = {
      invoke: async (data: unknown, params?: { needCheck?: boolean }) => {
        const onCardAction = this.dependencies.onCardAction;
        const normalizedBeforeDispatch = onCardAction
          ? normalizeCardActionPayload(data, undefined)
          : undefined;

        if (normalizedBeforeDispatch && onCardAction) {
          this.dependencies.logger?.info?.("feishu card action callback received");
          const result = await onCardAction(normalizedBeforeDispatch);
          this.dependencies.logger?.info?.(
            `feishu card action callback produced result: ${describeResultShape(result)}`,
          );
          return result;
        }

        const eventResult = await eventDispatcher.invoke(data, params);
        const normalizedCardAction = onCardAction
          ? normalizeCardActionPayload(data, eventResult)
          : undefined;

        if (normalizedCardAction && onCardAction) {
          this.dependencies.logger?.info?.("feishu card action callback received");
          const result = await onCardAction(normalizedCardAction);
          this.dependencies.logger?.info?.(
            `feishu card action callback produced result: ${describeResultShape(result)}`,
          );
          return result;
        }

        if (isMissingCardActionHandlerResult(eventResult)) {
          this.dependencies.logger?.warn?.(
            `feishu card action callback could not be normalized: ${describePayloadShape(data)}`,
          );
        }

        return eventResult;
      },
    };

    this.client = new sdk.WSClient({
      appId: this.dependencies.appId,
      appSecret: this.dependencies.appSecret,
      loggerLevel: sdk.LoggerLevel.info,
      logger: sdkLogger,
      autoReconnect: true,
      reconnectCount: this.dependencies.reconnectCount,
      reconnectInterval: this.dependencies.reconnectIntervalMs,
      reconnectNonce: this.dependencies.reconnectNonceMs,
    });
    this.patchWsClientDiagnostics(this.client as WsClientLike & WsClientDiagnosticsLike);
  }

  public async start(): Promise<void> {
    await this.client.start({
      eventDispatcher: this.dispatcher,
    });
  }

  public async stop(): Promise<void> {
    this.client.close({
      force: true,
    });
  }

  private patchWsClientDiagnostics(client: WsClientLike & WsClientDiagnosticsLike): void {
    if (typeof client.communicate !== "function") {
      return;
    }

    const originalCommunicate = client.communicate.bind(client);
    client.communicate = () => {
      originalCommunicate();
      this.attachWsSocketDiagnostics(client);
    };
  }

  private attachWsSocketDiagnostics(client: WsClientDiagnosticsLike): void {
    const wsInstance = client.wsConfig?.getWSInstance?.();
    if (!wsInstance || typeof wsInstance !== "object") {
      return;
    }

    const socketIdentity = wsInstance as object;
    if (this.instrumentedSockets.has(socketIdentity)) {
      return;
    }
    this.instrumentedSockets.add(socketIdentity);

    this.transportConnectCount += 1;
    const reconnectCount = this.transportConnectCount - 1;
    this.dependencies.logger?.info?.(
      reconnectCount > 0
        ? `feishu ws transport connected (reconnect #${reconnectCount})`
        : "feishu ws transport connected",
    );

    if (typeof wsInstance.on !== "function") {
      return;
    }

    wsInstance.on("close", (code: unknown, reason: unknown) => {
      this.dependencies.logger?.warn?.(formatWsCloseMessage(code, reason));
    });
    wsInstance.on("error", (error: unknown) => {
      const serializedError = serializeErrorLike(error);
      if (serializedError) {
        this.dependencies.logger?.error?.(
          {
            err: serializedError,
          },
          "feishu ws socket error",
        );
        return;
      }

      this.dependencies.logger?.error?.(`feishu ws socket error: ${String(error)}`);
    });
  }
}

function normalizeCardActionPayload(
  data: unknown,
  eventResult: unknown,
): NormalizedCardActionEvent | undefined {
  const candidate = extractCardActionCandidate(data, eventResult);
  if (!candidate) {
    return undefined;
  }

  const action = normalizeAction(candidate.action);
  const openId =
    readString(candidate.open_id) ??
    readString(readNested(candidate, ["operator", "open_id"])) ??
    readString(readNested(candidate, ["operator", "operator_id", "open_id"])) ??
    readString(readNested(candidate, ["user", "open_id"])) ??
    readString(readNested(candidate, ["user", "user_id", "open_id"]));

  if (!openId || !action) {
    return undefined;
  }

  return {
    open_id: openId,
    tenant_key:
      readString(candidate.tenant_key) ??
      readString(readNested(candidate, ["context", "tenant_key"])),
    open_message_id:
      readString(candidate.open_message_id) ??
      readString(readNested(candidate, ["context", "open_message_id"])),
    token:
      readString(candidate.token) ??
      readString(readNested(candidate, ["context", "token"])),
    action,
  };
}

function extractCardActionCandidate(
  data: unknown,
  eventResult: unknown,
): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const candidate = data as Record<string, unknown>;
  const schemaEventType = readString(readNested(candidate, ["header", "event_type"]));
  if (schemaEventType === "card.action.trigger") {
    return mergeEventPayload(candidate);
  }

  const eventType = readString(readNested(candidate, ["event", "type"]));
  if (eventType === "card.action.trigger") {
    return mergeEventPayload(candidate);
  }

  if (looksLikeFlatCardActionPayload(candidate)) {
    return candidate;
  }

  if (isMissingCardActionHandlerResult(eventResult) && readNested(candidate, ["event"])) {
    return mergeEventPayload(candidate);
  }

  return undefined;
}

function mergeEventPayload(candidate: Record<string, unknown>): Record<string, unknown> | undefined {
  const nestedEvent = readNested(candidate, ["event"]);
  if (!nestedEvent || typeof nestedEvent !== "object") {
    return undefined;
  }

  const { event: _event, header: _header, schema: _schema, ...rest } = candidate;
  return {
    ...rest,
    ...(nestedEvent as Record<string, unknown>),
  };
}

function looksLikeFlatCardActionPayload(candidate: Record<string, unknown>): boolean {
  const action = normalizeAction(candidate.action);
  if (!action) {
    return false;
  }

  const openId =
    readString(candidate.open_id) ??
    readString(readNested(candidate, ["operator", "open_id"])) ??
    readString(readNested(candidate, ["operator", "operator_id", "open_id"])) ??
    readString(readNested(candidate, ["user", "open_id"])) ??
    readString(readNested(candidate, ["user", "user_id", "open_id"]));

  return Boolean(openId);
}

function normalizeAction(value: unknown): NormalizedCardActionEvent["action"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const normalized: NormalizedCardActionEvent["action"] = {};
  const tag = readString(candidate.tag);
  if (tag) {
    normalized.tag = tag;
  }

  const name = readString(candidate.name);
  if (name) {
    normalized.name = name;
  }

  const actionValue = candidate.value;
  if (actionValue && typeof actionValue === "object") {
    normalized.value = actionValue as Record<string, unknown>;
  }

  const formValue = candidate.form_value;
  if (formValue && typeof formValue === "object") {
    normalized.form_value = formValue as Record<string, unknown>;
  }

  return normalized;
}

function isMissingCardActionHandlerResult(result: unknown): boolean {
  if (typeof result !== "string") {
    return false;
  }

  const normalized = result.toLowerCase();
  return normalized.startsWith("no ") && normalized.includes("card.action.trigger") && normalized.includes("handle");
}

function readNested(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function describePayloadShape(data: unknown): string {
  if (!data || typeof data !== "object") {
    return typeof data;
  }

  return Object.keys(data as Record<string, unknown>).sort().join(",");
}

function describeResultShape(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result);
  }

  const candidate = result as Record<string, unknown>;
  const rawCard =
    readNested(candidate, ["card", "data"]) &&
    typeof readNested(candidate, ["card", "data"]) === "object"
      ? (readNested(candidate, ["card", "data"]) as Record<string, unknown>)
      : candidate;
  const title = readString(readNested(rawCard, ["header", "title", "content"])) ?? "";
  const elements = Array.isArray(rawCard.elements)
    ? rawCard.elements.length
    : Array.isArray(readNested(rawCard, ["body", "elements"]))
      ? (readNested(rawCard, ["body", "elements"]) as unknown[]).length
      : 0;
  return `keys=${Object.keys(candidate).sort().join(",")};title=${title};elements=${elements}`;
}

function formatWsCloseMessage(code: unknown, reason: unknown): string {
  const details: string[] = [];

  const normalizedCode =
    typeof code === "number" || typeof code === "string"
      ? String(code)
      : undefined;
  if (normalizedCode && normalizedCode.length > 0) {
    details.push(`code=${normalizedCode}`);
  }

  const normalizedReason = decodeWsCloseReason(reason);
  if (normalizedReason) {
    details.push(`reason=${normalizedReason}`);
  }

  return details.length > 0
    ? `feishu ws socket closed: ${details.join("; ")}`
    : "feishu ws socket closed";
}

function decodeWsCloseReason(reason: unknown): string | undefined {
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }

  if (reason instanceof Uint8Array && reason.byteLength > 0) {
    const decoded = Buffer.from(reason).toString("utf8").trim();
    return decoded.length > 0 ? decoded : undefined;
  }

  return undefined;
}

function serializeErrorLike(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof Error) {
    const errorRecord = error as Error & Record<string, unknown>;
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) {
      serialized.stack = error.stack;
    }

    const extraKeys = [
      "code",
      "errno",
      "syscall",
      "hostname",
      "host",
      "address",
      "port",
    ];
    for (const key of extraKeys) {
      const value = errorRecord[key];
      if (value !== undefined) {
        serialized[key] = value;
      }
    }

    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
      serialized.cause = serializeErrorLike(cause) ?? cause;
    }
    return serialized;
  }

  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    return Object.keys(candidate).length > 0 ? { ...candidate } : undefined;
  }

  if (typeof error === "string" && error.length > 0) {
    return {
      message: error,
    };
  }

  return undefined;
}

export function createSdkLogger(logger?: BaseLoggerLike) {
  if (!logger) {
    return undefined;
  }

  return {
    info: (...args: unknown[]) => {
      if (!logger.info) {
        return;
      }
      logger.info(formatSdkLogArgs(args));
    },
    warn: (...args: unknown[]) => {
      if (!logger.warn) {
        return;
      }
      logger.warn(formatSdkLogArgs(args));
    },
    debug: (...args: unknown[]) => {
      if (!logger.debug) {
        return;
      }
      logger.debug(formatSdkLogArgs(args));
    },
    error: (...args: unknown[]) => {
      if (!logger.error) {
        return;
      }
      logger.error(formatSdkLogArgs(args));
    },
  };
}

function formatSdkLogArgs(args: unknown[]): string {
  return flattenSdkLogArgs(args)
    .map(arg => {
      if (typeof arg === "string") {
        return arg;
      }

      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function flattenSdkLogArgs(args: unknown[]): unknown[] {
  return args.flatMap(arg => Array.isArray(arg) ? flattenSdkLogArgs(arg) : [arg]);
}
