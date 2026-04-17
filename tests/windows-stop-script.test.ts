import { describe, expect, it } from "vitest";

// @ts-ignore
import { buildWindowsProtectedPidQuery, parseProtectedWindowsPids } from "../scripts/stop-support.mjs";

describe("Windows stop script helpers", () => {
  it("builds a protected PID query without assigning to PowerShell's readonly $PID variable", () => {
    const query = buildWindowsProtectedPidQuery(1234);

    expect(query).toContain("$currentPidValue = 1234");
    expect(query).toContain("$probePid = $currentPidValue");
    expect(query).toContain('Get-CimInstance Win32_Process -Filter "ProcessId = $probePid"');
    expect(query).not.toContain("$pid = 1234");
  });

  it("parses single values, arrays, and empty output into a usable PID list", () => {
    expect(parseProtectedWindowsPids("[1234,4321]", 9999)).toEqual([1234, 4321]);
    expect(parseProtectedWindowsPids("1234", 9999)).toEqual([1234]);
    expect(parseProtectedWindowsPids("", 9999)).toEqual([9999]);
  });
});
