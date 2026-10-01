import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import type { Express } from "express";
import { generateCode } from "../../src/shared/crypto/totp";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/migrate";
import { verifyToken } from "../../src/shared/crypto/jwt";
import { PgAuthRepository } from "../../src/modules/auth/auth.pg-repository";
import { PgSessionsRepository } from "../../src/modules/sessions/sessions.pg-repository";
import { PgMfaRepository } from "../../src/modules/mfa/mfa.pg-repository";
import { PgAuditRepository } from "../../src/modules/audit/audit.pg-repository";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthService } from "../../src/modules/auth/auth.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { MfaService } from "../../src/modules/mfa/mfa.service";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/login";
process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

const EMAIL = "mfa@example.com";
const PASSWORD = "Str0ng!Passw0rd";

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
  app = createApp({ authService: auth, sessionsService: sessions, mfaService: mfa });
  await request(app).post("/auth/register").send({ email: EMAIL, password: PASSWORD });
});

afterAll(async () => {
  await poolEnd();
});

describe("MFA end to end", () => {
  it("setup -> confirm -> login with ticket -> verify returns mfa:true tokens", async () => {
    const pre = await request(app).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    const token = pre.body.accessToken as string;
    const setupRes = await request(app).post("/mfa/setup").set("Authorization", `Bearer ${token}`);
    expect(setupRes.status).toBe(200);
    const secret = setupRes.body.secret as string;
    const confirm = await request(app)
      .post("/mfa/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: generateCode(secret) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    const login = await request(app).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    const verify = await request(app)
      .post("/auth/mfa/verify")
      .send({ ticket: login.body.mfaTicket, code: generateCode(secret) });
    expect(verify.status).toBe(200);
    const payload = verifyToken(verify.body.accessToken);
    expect(payload).toMatchObject({ mfa: true });
  });

  it("3 wrong codes leave 3 mfa_failure audit rows", async () => {
    const login = await request(app).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    const before = (await poolQuery("SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = 'mfa_failure'")).rows[0].n as number;
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/auth/mfa/verify").send({ ticket: login.body.mfaTicket, code: "000000" });
      expect(res.status).toBe(401);
    }
    const after = (await poolQuery("SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = 'mfa_failure'")).rows[0].n as number;
    expect(after - before).toBe(3);
  });
});
