export interface ParsedCodexAppDirective {
  name: string;
  attributes: Record<string, string>;
  rawLine: string;
}

export interface ParsedCodexAppDirectiveText {
  visibleText: string;
  directives: ParsedCodexAppDirective[];
}

const DIRECTIVE_LINE_PATTERN = /^::([a-z0-9-]+)\{(.*)\}$/i;
const DIRECTIVE_ATTRIBUTE_PATTERN = /([a-zA-Z0-9_]+)="((?:[^"\\]|\\.)*)"/g;

export function parseCodexAppDirectives(text: string): ParsedCodexAppDirectiveText {
  const lines = text.split(/\r?\n/);
  const visibleLines: string[] = [];
  const directives: ParsedCodexAppDirective[] = [];
  let insideFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      insideFence = !insideFence;
      visibleLines.push(line);
      continue;
    }

    if (!insideFence) {
      const directive = parseDirectiveLine(trimmed);
      if (directive) {
        directives.push(directive);
        continue;
      }
    }

    visibleLines.push(line);
  }

  return {
    visibleText: collapseDirectiveGaps(visibleLines.join("\n")),
    directives,
  };
}

function parseDirectiveLine(trimmedLine: string): ParsedCodexAppDirective | undefined {
  const match = DIRECTIVE_LINE_PATTERN.exec(trimmedLine);
  if (!match) {
    return undefined;
  }

  const [, name, rawAttributes] = match;
  return {
    name,
    attributes: parseDirectiveAttributes(rawAttributes),
    rawLine: trimmedLine,
  };
}

function parseDirectiveAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = DIRECTIVE_ATTRIBUTE_PATTERN.exec(text)) !== null) {
    const [, key, rawValue] = match;
    attributes[key] = rawValue
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
  return attributes;
}

function collapseDirectiveGaps(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
