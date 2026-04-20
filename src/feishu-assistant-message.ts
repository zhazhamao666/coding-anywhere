import { containsMarkdownSyntax, normalizeMarkdownToPlainText } from "./markdown-text.js";

export type FeishuAssistantMessageDelivery =
  | {
      kind: "card";
      card: Record<string, unknown>;
    }
  | {
      kind: "text";
      text: string;
    };

const FEISHU_INTERACTIVE_CARD_MAX_BYTES = 30 * 1024;

export function resolveFeishuAssistantMessageDelivery(text: string): FeishuAssistantMessageDelivery {
  const markdownCard = buildAssistantMarkdownCard(text);
  if (markdownCard) {
    return {
      kind: "card",
      card: markdownCard,
    };
  }

  return {
    kind: "text",
    text: normalizeAssistantPlainText(text),
  };
}

export function buildAssistantMarkdownCard(text: string): Record<string, unknown> | undefined {
  if (!shouldRenderAssistantAsMarkdownCard(text)) {
    return undefined;
  }

  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const card = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildAssistantSummary(normalized),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: "完整回复",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: normalized,
        },
      ],
    },
  } satisfies Record<string, unknown>;

  return Buffer.byteLength(JSON.stringify(card), "utf8") <= FEISHU_INTERACTIVE_CARD_MAX_BYTES
    ? card
    : undefined;
}

export function normalizeAssistantPlainText(text: string): string {
  return normalizeMarkdownToPlainText(text);
}

function shouldRenderAssistantAsMarkdownCard(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  if (normalized.length <= 120 && !containsMarkdownSyntax(normalized)) {
    return false;
  }

  return containsMarkdownSyntax(normalized) || normalized.includes("\n");
}

function buildAssistantSummary(text: string): string {
  const firstLine = normalizeMarkdownToPlainText(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) ?? "完整回复";
  return firstLine.slice(0, 120);
}
