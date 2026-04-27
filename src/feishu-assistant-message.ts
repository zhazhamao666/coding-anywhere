import { execFileSync } from "node:child_process";
import path from "node:path";

import { parseCodexAppDirectives } from "./codex-app-directive.js";
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
  const visibleText = buildFeishuVisibleAssistantText(text);
  const markdownCard = buildAssistantMarkdownCard(visibleText);
  if (markdownCard) {
    return {
      kind: "card",
      card: markdownCard,
    };
  }

  return {
    kind: "text",
    text: normalizeAssistantPlainText(visibleText),
  };
}

export function buildFeishuVisibleAssistantText(text: string): string {
  const parsed = parseCodexAppDirectives(text);
  const gitSummaryLines = buildGitDirectiveSummaryLines(parsed.directives);
  if (gitSummaryLines.length === 0) {
    return parsed.visibleText;
  }

  if (!parsed.visibleText) {
    return gitSummaryLines.join("\n");
  }

  return `${parsed.visibleText}\n\n${gitSummaryLines.join("\n")}`;
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
      width_mode: "fill",
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

function buildGitDirectiveSummaryLines(
  directives: ReturnType<typeof parseCodexAppDirectives>["directives"],
): string[] {
  const directivesByCwd = new Map<string, Set<string>>();
  for (const directive of directives) {
    if (!isGitDirectiveName(directive.name)) {
      continue;
    }

    const cwd = directive.attributes.cwd?.trim();
    if (!cwd) {
      continue;
    }

    const existing = directivesByCwd.get(cwd) ?? new Set<string>();
    existing.add(directive.name);
    directivesByCwd.set(cwd, existing);
  }

  const summaries = [...directivesByCwd.entries()]
    .map(([cwd, names]) => {
      const fileCount = resolveGitDirectiveFileCount(cwd, names);
      if (!fileCount || fileCount <= 0) {
        return undefined;
      }

      return {
        cwd,
        fileCount,
      };
    })
    .filter((item): item is { cwd: string; fileCount: number } => Boolean(item));

  if (summaries.length === 0) {
    return [];
  }

  if (summaries.length === 1) {
    return [formatChangedFileSummary(summaries[0].fileCount)];
  }

  return summaries.map(summary => `${path.basename(summary.cwd) || summary.cwd}：${formatChangedFileSummary(summary.fileCount)}`);
}

function resolveGitDirectiveFileCount(cwd: string, directiveNames: Set<string>): number | undefined {
  try {
    if (directiveNames.has("git-commit")) {
      return countUniqueLines(
        execGit(cwd, ["show", "--name-only", "--format=", "--diff-filter=ACMR", "HEAD"]),
      );
    }

    if (directiveNames.has("git-stage")) {
      return countUniqueLines(
        execGit(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
      );
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function countUniqueLines(output: string): number {
  return new Set(
    output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean),
  ).size;
}

function formatChangedFileSummary(fileCount: number): string {
  return `${fileCount} 个文件已更改`;
}

function isGitDirectiveName(name: string): boolean {
  return name === "git-stage" ||
    name === "git-commit" ||
    name === "git-push" ||
    name === "git-create-branch" ||
    name === "git-create-pr";
}
