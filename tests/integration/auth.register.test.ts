import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/migrate";
import { PgAuthRepository } from "../../src/modules/auth/auth.pg-repository";
import { PgAuditRepository } from "../../src/modules/audit/audit.pg-repository";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthService } from "../../src/modules/auth/auth.service";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/login";
process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

let app: Express;
let poolEnd: () => Promise<void>;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  poolEnd = () => pool.end();
  await runMigrations(pool);
  const audit = new AuditService(new PgAuditRepository(pool));
  const auth = new AuthService(new PgAuthRepository(pool), audit);
  app = createApp({ authService: auth });
});

afterAll(async () => {
  await poolEnd();
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
