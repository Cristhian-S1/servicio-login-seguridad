import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.DB_PATH ??= ":memory:";
process.env.JWT_SECRET ??= "a".repeat(32);

let app: Express;

beforeAll(async () => {
  const mod = await import("../../src/app");
  app = mod.createApp();
});

describe("GET /health", () => {
  it("returns 200 with status ok and a request id", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toBeDefined();
  });
});
