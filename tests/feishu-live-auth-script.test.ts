import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  bootstrapFeishuLiveAuth,
  type FeishuLiveAuthBootstrapDependencies,
} from "../src/feishu-live-auth.js";

describe("feishu live auth bootstrap", () => {
  it("launches a maximized persistent browser profile and writes refresh metadata", async () => {
    const goto = vi.fn(async () => undefined);
    const closePage = vi.fn(async () => undefined);
    const page = {
      goto,
      close: closePage,
    };
    const closeContext = vi.fn(async () => undefined);
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: closeContext,
    };
    const mkdirSync = vi.fn();
    const writeFileSync = vi.fn();

    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const deps: FeishuLiveAuthBootstrapDependencies = {
      launchPersistentContext: vi.fn(async (_userDataDir, _options) => context as any),
      mkdirSync,
      writeFileSync,
      now: () => new Date("2026-04-10T08:00:00.000Z"),
      stdout,
      stdin,
      createInterface: () => ({
        question: (_prompt: string, callback: (answer: string) => void) => callback("done"),
        close: vi.fn(),
      }),
    };

    await bootstrapFeishuLiveAuth(
      {
        cwd: "D:\\repo\\coding-anywhere",
      },
      deps,
    );

    expect(mkdirSync).toHaveBeenCalledWith(
      "D:\\repo\\coding-anywhere\\.auth",
      { recursive: true },
    );
    expect(deps.launchPersistentContext).toHaveBeenCalledWith(
      "D:\\repo\\coding-anywhere\\.auth\\feishu-profile",
      expect.objectContaining({
        headless: false,
        args: expect.arrayContaining(["--start-maximized"]),
        viewport: null,
      }),
    );
    expect(goto).toHaveBeenCalledWith("https://feishu.cn/messages/", {
      waitUntil: "domcontentloaded",
    });
    expect(writeFileSync).toHaveBeenCalledWith(
      "D:\\repo\\coding-anywhere\\.auth\\feishu-live-auth.json",
      expect.stringContaining("\"refreshedAt\":\"2026-04-10T08:00:00.000Z\""),
      "utf8",
    );
    expect(closeContext).toHaveBeenCalledTimes(1);
  });
});
