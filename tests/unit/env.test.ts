import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env";

const BASE_ENV = {
  DB_PATH: ":memory:",
  JWT_SECRET: "a".repeat(32),
};

describe("loadEnv", () => {
  it("throws when JWT_SECRET is missing", () => {
    const { JWT_SECRET: _drop, ...rest } = BASE_ENV;
    expect(() => loadEnv(rest)).toThrow(/JWT_SECRET/);
  });

  it("throws when JWT_SECRET is shorter than 32 bytes", () => {
    expect(() => loadEnv({ ...BASE_ENV, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("loads defaults for optional vars on a valid env", () => {
    const env = loadEnv(BASE_ENV);
    expect(env.ACCESS_TTL_MINUTES).toBe(15);
    expect(env.DB_PATH).toBe(":memory:");
  });
});
