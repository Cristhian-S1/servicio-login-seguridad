import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/migrate";
import { signAccessToken } from "../../src/shared/crypto/jwt";
import { PgAuthRepository } from "../../src/modules/auth/auth.pg-repository";
import { PgSessionsRepository } from "../../src/modules/sessions/sessions.pg-repository";
import { PgUsersRepository } from "../../src/modules/users/users.pg-repository";
import { PgMfaRepository } from "../../src/modules/mfa/mfa.pg-repository";
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
let userId = "";
let adminId = "";

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
  const usersService = new UsersService(new PgUsersRepository(pool));
  app = createApp({ authService: auth, sessionsService: sessions, mfaService: mfa, usersService });
  userId = (await request(app).post("/auth/register").send({ email: "u@example.com", password: "Str0ng!Passw0rd" })).body.id;
  adminId = (await request(app).post("/auth/register").send({ email: "a@example.com", password: "Str0ng!Passw0rd" })).body.id;
  await poolQuery("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
});

afterAll(async () => {
  await poolEnd();
});

const userToken = () => signAccessToken({ sub: userId, role: "user", mfa: false });
const adminNoMfa = () => signAccessToken({ sub: adminId, role: "admin", mfa: false });
const adminMfa = () => signAccessToken({ sub: adminId, role: "admin", mfa: true });

describe("RBAC matrix", () => {
  it("GET /admin/users without token is 401", async () => {
    expect((await request(app).get("/admin/users")).status).toBe(401);
  });

  it("GET /admin/users with user token is 403", async () => {
    const res = await request(app).get("/admin/users").set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("GET /admin/users with admin but mfa:false is 403 mfa_required", async () => {
    const res = await request(app).get("/admin/users").set("Authorization", `Bearer ${adminNoMfa()}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("mfa_required");
  });

  it("GET /admin/users with admin + mfa:true is 200 with both users", async () => {
    const res = await request(app).get("/admin/users").set("Authorization", `Bearer ${adminMfa()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("GET /users/me returns the profile with no hash", async () => {
    const res = await request(app).get("/users/me").set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: userId, email: "u@example.com" });
    expect(res.body).not.toHaveProperty("password_hash");
  });
});
