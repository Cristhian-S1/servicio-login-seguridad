import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/sqlite";
import { SqliteAuthRepository } from "../../src/modules/auth/auth.sqlite-repository";
import { AuthService } from "../../src/modules/auth/auth.service";

process.env.DB_PATH ??= ":memory:";
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

describe("POST /auth/register", () => {
  it("creates the user with 201 and no password hash in the body", async () => {
    const res = await request(app).post("/auth/register").send({ email: "new@example.com", password: "Str0ng!Passw0rd" });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe("new@example.com");
    expect(res.body.id).toBeDefined();
    expect(res.body).not.toHaveProperty("password_hash");
  });

  it("returns 409 on duplicate email", async () => {
    await request(app).post("/auth/register").send({ email: "dup@example.com", password: "Str0ng!Passw0rd" });
    const res = await request(app).post("/auth/register").send({ email: "dup@example.com", password: "Str0ng!Passw0rd" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("returns 400 on weak password", async () => {
    const res = await request(app).post("/auth/register").send({ email: "w@example.com", password: "weak" });
    expect(res.status).toBe(400);
  });
});
