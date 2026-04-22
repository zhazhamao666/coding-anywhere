const SYNTHETIC_DESKTOP_REMINDER_WRAPPER_TAGS = new Set([
  "subagent_notification",
  "turn_aborted",
]);

export function isSyntheticDesktopReminderText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const wrapperMatch = trimmed.match(/^<([a-z_]+)>\s*[\s\S]*\s*<\/\1>$/i);
  if (!wrapperMatch?.[1]) {
    return false;
  }

  return SYNTHETIC_DESKTOP_REMINDER_WRAPPER_TAGS.has(wrapperMatch[1].toLowerCase());
}
