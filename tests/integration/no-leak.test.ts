import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/migrate";
import { PgAuthRepository } from "../../src/modules/auth/auth.pg-repository";
import { PgSessionsRepository } from "../../src/modules/sessions/sessions.pg-repository";
import { PgMfaRepository } from "../../src/modules/mfa/mfa.pg-repository";
import { PgUsersRepository } from "../../src/modules/users/users.pg-repository";
import { PgAuditRepository } from "../../src/modules/audit/audit.pg-repository";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthService } from "../../src/modules/auth/auth.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { MfaService } from "../../src/modules/mfa/mfa.service";
import { UsersService } from "../../src/modules/users/users.service";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/login";
process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

let app: Express;
let poolEnd: () => Promise<void>;
let poolQuery: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  poolEnd = () => pool.end();
  poolQuery = (text: string, params?: unknown[]) => pool.query(text, params);
  await runMigrations(pool);
  const audit = new AuditService(new PgAuditRepository(pool));
  const users = new PgAuthRepository(pool);
  const sessions = new SessionsService(new PgSessionsRepository(pool), users, audit);
  const mfa = new MfaService(new PgMfaRepository(pool), users, sessions, audit);
  const auth = new AuthService(users, audit, sessions);
  app = createApp({ authService: auth, sessionsService: sessions, mfaService: mfa, usersService: new UsersService(new PgUsersRepository(pool)) });
});

afterAll(async () => {
  await poolEnd();
});

describe("stored secrets are hashes, never raw values", () => {
  it("refresh token is stored as SHA-256, password as argon2id", async () => {
    await request(app).post("/auth/register").send({ email: "leak@example.com", password: "Str0ng!Passw0rd" });
    const login = await request(app).post("/auth/login").send({ email: "leak@example.com", password: "Str0ng!Passw0rd" });
    const raw: string = login.body.refreshToken;
    const tokens = (await poolQuery("SELECT token_hash FROM refresh_tokens")).rows;
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hash).not.toBe(raw);
    expect(tokens[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    const users = (await poolQuery("SELECT password_hash FROM users")).rows;
    expect(users[0].password_hash).not.toContain("Str0ng!Passw0rd");
    expect(String(users[0].password_hash)).toMatch(/^\$argon2id\$/);
  });

  it("an oversized JSON body is rejected without a 500", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "big@example.com", password: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("validation_error");
  });
});
