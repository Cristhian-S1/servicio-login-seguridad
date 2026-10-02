import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";

process.env.DB_PATH ??= ":memory:";
process.env.JWT_SECRET ??= "a".repeat(32);

describe("docs", () => {
  it("serves swagger-ui html", async () => {
    const res = await request(createApp()).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  it("serves the raw spec with the login endpoints", async () => {
    const res = await request(createApp()).get("/docs.json");
    expect(res.status).toBe(200);
    for (const p of ["/auth/register", "/auth/login"]) {
      expect(res.body.paths, p).toHaveProperty(p);
    }
    expect(res.body.components.securitySchemes).toHaveProperty("bearerAuth");
  });
});
