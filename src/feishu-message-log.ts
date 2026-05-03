function normalizeSnippet(value: string | undefined, limit: number): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function summarizeFeishuText(text: string | undefined, limit = 80): string | undefined {
  return normalizeSnippet(text, limit);
}

export function summarizeFeishuCard(
  card: Record<string, unknown> | undefined,
  limit = 60,
): string | undefined {
  if (!card) {
    return undefined;
  }

  const title = readNestedString(card, ["header", "title", "content"]);
  if (title) {
    return normalizeSnippet(title, limit);
  }

  const bodyTitle = readNestedString(card, ["body", "title", "content"]);
  if (bodyTitle) {
    return normalizeSnippet(bodyTitle, limit);
  }

  const schema = typeof card.schema === "string" ? card.schema : undefined;
  return schema ? `schema:${schema}` : undefined;
}

export function buildFeishuInboundLog(input: {
  chatType?: string;
  messageId?: string;
  chatId?: string;
  threadId?: string;
  peerId: string;
  text: string;
}): string {
  const parts = [
    "feishu recv",
    `peer=${input.peerId}`,
    input.chatType ? `chat_type=${input.chatType}` : undefined,
    input.messageId ? `message_id=${input.messageId}` : undefined,
    input.chatId ? `chat_id=${input.chatId}` : undefined,
    input.threadId ? `thread_id=${input.threadId}` : undefined,
    formatSummary("text", summarizeFeishuText(input.text)),
  ];

  return parts.filter(Boolean).join(" ");
}

export function buildFeishuOutboundLog(input: {
  mode: string;
  messageType: "text" | "interactive" | "image" | "file";
  messageId?: string;
  peerId?: string;
  chatId?: string;
  threadId?: string;
  anchorMessageId?: string;
  cardId?: string;
  imageKey?: string;
  fileKey?: string;
  text?: string;
  card?: Record<string, unknown>;
}): string {
  const parts = [
    "feishu send",
    `mode=${input.mode}`,
    `type=${input.messageType}`,
    input.messageId ? `message_id=${input.messageId}` : undefined,
    input.anchorMessageId ? `anchor_message_id=${input.anchorMessageId}` : undefined,
    input.peerId ? `peer=${input.peerId}` : undefined,
    input.chatId ? `chat_id=${input.chatId}` : undefined,
    input.threadId ? `thread_id=${input.threadId}` : undefined,
    input.cardId ? `card_id=${input.cardId}` : undefined,
    input.messageType === "text"
      ? formatSummary("text", summarizeFeishuText(input.text))
      : input.messageType === "interactive"
        ? formatSummary("card", summarizeFeishuCard(input.card))
        : input.messageType === "image"
          ? formatSummary("image_key", input.imageKey)
          : formatSummary("file_key", input.fileKey),
  ];

  return parts.filter(Boolean).join(" ");
}

function formatSummary(label: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return `${label}="${value.replace(/"/g, '\\"')}"`;
}

function readNestedString(value: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = value;

  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.length > 0 ? current : undefined;
}
