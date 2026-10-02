import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/login";
process.env.JWT_SECRET ??= "a".repeat(32);

const PATHS = [
  "/auth/register",
  "/auth/login",
  "/auth/refresh",
  "/auth/logout",
  "/auth/mfa/verify",
  "/mfa/setup",
  "/mfa/confirm",
  "/users/me",
  "/admin/users",
];

describe("docs", () => {
  it("serves swagger-ui html", async () => {
    const res = await request(createApp()).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  it("serves the raw spec with every endpoint", async () => {
    const res = await request(createApp()).get("/docs.json");
    expect(res.status).toBe(200);
    for (const p of PATHS) {
      expect(res.body.paths, p).toHaveProperty(p);
    }
    expect(res.body.components.securitySchemes).toHaveProperty("bearerAuth");
  });
});
