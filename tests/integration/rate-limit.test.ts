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
process.env.RATE_LIMIT_LOGIN_MAX ??= "2";
process.env.RATE_LIMIT_LOGIN_WINDOW_MS ??= "60000";
process.env.RATE_LIMIT_GLOBAL_MAX ??= "1000";

let app: Express;
let poolEnd: () => Promise<void>;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  poolEnd = () => pool.end();
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

describe("login rate limiting", () => {
  it("3rd attempt with the same email is 429 with Retry-After", async () => {
    const body = { email: "limited@example.com", password: "Wrong!Passw0rd1" };
    expect((await request(app).post("/auth/login").send(body)).status).toBe(401);
    expect((await request(app).post("/auth/login").send(body)).status).toBe(401);
    const third = await request(app).post("/auth/login").send(body);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("rate_limited");
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("a different email from the same IP is still allowed", async () => {
    const res = await request(app).post("/auth/login").send({ email: "other@example.com", password: "Wrong!Passw0rd1" });
    expect(res.status).toBe(401);
  });
});
