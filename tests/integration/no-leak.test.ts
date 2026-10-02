import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/sqlite";
import { SqliteAuthRepository } from "../../src/modules/auth/auth.sqlite-repository";
import { AuthService } from "../../src/modules/auth/auth.service";

process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

let app: Express;
let db: Database.Database;

beforeAll(async () => {
  db = new Database(":memory:");
  await runMigrations(db);
  app = createApp({ authService: new AuthService(new SqliteAuthRepository(db)) });
});

afterAll(async () => {
  db.close();
});

describe("stored secrets are hashes, never raw values", () => {
  it("password is stored as argon2id", async () => {
    await request(app).post("/auth/register").send({ email: "leak@example.com", password: "Str0ng!Passw0rd" });
    const rows = db.prepare("SELECT password_hash FROM users").all() as Array<{ password_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toContain("Str0ng!Passw0rd");
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it("an oversized JSON body is rejected without a 500", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "big@example.com", password: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("validation_error");
  });
});
