import { describe, expect, it } from "vitest";

import { createTimestampPrefixingConsoleStream } from "../src/timestamped-console-stream.js";

describe("createTimestampPrefixingConsoleStream", () => {
  it("prefixes every completed line with millisecond timestamps", () => {
    const output: string[] = [];
    const stream = createTimestampPrefixingConsoleStream(
      {
        write(chunk: string) {
          output.push(chunk);
          return true;
        },
      },
      () => new Date(2026, 2, 31, 9, 8, 7, 6),
    );

    stream.write("first");
    stream.write("\nsecond line\n");

    expect(output.join("")).toBe(
      "[2026-03-31 09:08:07.006] first\n[2026-03-31 09:08:07.006] second line\n",
    );
  });
});
