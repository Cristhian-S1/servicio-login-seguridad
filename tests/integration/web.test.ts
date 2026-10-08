import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";

process.env.DB_PATH ??= ":memory:";
process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

describe("frontend de verificacion", () => {
  it("sirve la pagina en /", async () => {
    const res = await request(createApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("la pagina permite probar salud, registro y login", async () => {
    const res = await request(createApp()).get("/");
    expect(res.text).toMatch(/registro/i);
    expect(res.text).toMatch(/login/i);
    expect(res.text).toContain("/health");
  });
});
