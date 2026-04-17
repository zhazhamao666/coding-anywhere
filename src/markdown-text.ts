export function containsMarkdownSyntax(text: string): boolean {
  return /(^|\n)\s*[-*]\s+/.test(text) ||
    /(^|\n)\s*\d+\.\s+/.test(text) ||
    /(^|\n)\s*>/.test(text) ||
    /(^|\n)\s*#{1,6}\s+/.test(text) ||
    /```/.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /\|.+\|/.test(text);
}

export function normalizeMarkdownToPlainText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return text;
  }

  return normalized
    .replace(/```([\s\S]*?)```/g, (_match, code: string) => code.trim())
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*[-*]\s+/g, "$1• ")
    .replace(/(^|\n)\s*\d+\.\s+/g, (_match, prefix: string) => `${prefix}1. `)
    .trim();
}
