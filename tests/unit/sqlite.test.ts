import { describe, expect, it } from "vitest";
import { resolveDbPath } from "../../src/shared/db/sqlite";

describe("resolveDbPath", () => {
  it("mantiene :memory: como base en memoria sin convertirla en archivo", () => {
    expect(resolveDbPath(":memory:")).toBe(":memory:");
  });

  it("resuelve rutas de archivo a absolutas", () => {
    const resolved = resolveDbPath("./data/login.db");
    expect(resolved.startsWith("/")).toBe(true);
    expect(resolved).toMatch(/\/data\/login\.db$/);
  });
});
