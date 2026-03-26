import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("/readyz", () => {
  it("returns 503 when runtime dependencies are not ready", async () => {
    const app = buildApp({
      readinessProbe: async () => false,
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not-ready" });
  });
});
