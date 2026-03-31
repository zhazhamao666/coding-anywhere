interface WritableLike {
  write(chunk: string): boolean;
}

export function createTimestampPrefixingConsoleStream(
  output: WritableLike,
  now: () => Date = () => new Date(),
) {
  let pending = "";

  return {
    write(chunk: string | Buffer) {
      pending += chunk.toString();
      let newlineIndex = pending.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        output.write(`[${formatConsoleTimestamp(now())}] ${line}\n`);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }

      return true;
    },
  };
}

export function formatConsoleTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1, 2);
  const day = pad(value.getDate(), 2);
  const hours = pad(value.getHours(), 2);
  const minutes = pad(value.getMinutes(), 2);
  const seconds = pad(value.getSeconds(), 2);
  const milliseconds = pad(value.getMilliseconds(), 3);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
