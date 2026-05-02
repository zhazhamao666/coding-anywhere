const FEISHU_ERROR_REPLY_MAX_CHARS = 4_096;
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const TRUNCATED_ERROR_SUFFIX = "\n\n[ca] 错误详情已截断，完整内容请查看后台 run 日志。";

export function formatFeishuCaErrorText(error: unknown): string {
  const prefix = "[ca] error: ";
  return `${prefix}${formatFeishuErrorText(error, FEISHU_ERROR_REPLY_MAX_CHARS - prefix.length)}`;
}

export function formatFeishuErrorText(error: unknown, maxChars = FEISHU_ERROR_REPLY_MAX_CHARS): string {
  const cleaned = cleanFeishuErrorText(readErrorText(error));
  return truncateFeishuErrorText(cleaned, maxChars);
}

function readErrorText(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "RUN_STREAM_FAILED";
}

function cleanFeishuErrorText(text: string): string {
  const cleaned = text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .trim();
  return cleaned || "RUN_STREAM_FAILED";
}

function truncateFeishuErrorText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= TRUNCATED_ERROR_SUFFIX.length) {
    return text.slice(0, Math.max(maxChars, 0));
  }

  return `${text.slice(0, maxChars - TRUNCATED_ERROR_SUFFIX.length).trimEnd()}${TRUNCATED_ERROR_SUFFIX}`;
}
