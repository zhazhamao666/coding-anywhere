import { describe, expect, it } from "vitest";

import {
  assertFeishuLiveAuthReady,
  getFeishuLiveAuthPaths,
} from "../src/feishu-live-auth.js";

describe("feishu live auth config", () => {
  it("resolves local-only auth artifact paths under .auth", () => {
    const paths = getFeishuLiveAuthPaths({
      cwd: "D:\\repo\\coding-anywhere",
    });

    expect(paths.authDir).toBe("D:\\repo\\coding-anywhere\\.auth");
    expect(paths.profileDir).toBe("D:\\repo\\coding-anywhere\\.auth\\feishu-profile");
    expect(paths.metadataPath).toBe("D:\\repo\\coding-anywhere\\.auth\\feishu-live-auth.json");
  });

  it("throws a clear error when the persistent feishu profile is missing", () => {
    expect(() =>
      assertFeishuLiveAuthReady(
        {
          cwd: "D:\\repo\\coding-anywhere",
        },
        {
          existsSync: () => false,
        },
      ),
    ).toThrowError(
      "[ca] Feishu live auth is not ready. Run `npm run test:feishu:auth` and complete the login flow first.",
    );
  });

  it("accepts the profile when the persistent auth directory exists", () => {
    const result = assertFeishuLiveAuthReady(
      {
        cwd: "D:\\repo\\coding-anywhere",
      },
      {
        existsSync: target => String(target).endsWith("feishu-profile"),
      },
    );

    expect(result.profileDir).toBe("D:\\repo\\coding-anywhere\\.auth\\feishu-profile");
  });
});
