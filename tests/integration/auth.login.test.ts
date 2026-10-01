import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import express, { type Express } from "express";
import helmet from "helmet";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/migrate";
import { PgAuthRepository } from "../../src/modules/auth/auth.pg-repository";
import { PgSessionsRepository } from "../../src/modules/sessions/sessions.pg-repository";
import { PgSessionsRepository } from "../../src/modules/sessions/sessions.pg-repository";
import { PgAuditRepository } from "../../src/modules/audit/audit.pg-repository";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthService } from "../../src/modules/auth/auth.service";
import { requireAuth } from "../../src/shared/http/requireAuth";
import { errorHandler } from "../../src/shared/http/errorHandler";
import { SessionsService } from "../../src/modules/sessions/sessions.service";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/login";
process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

const EMAIL = "login@example.com";
const PASSWORD = "Str0ng!Passw0rd";

let app: Express;
let probe: Express;
let poolEnd: () => Promise<void>;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  poolEnd = () => pool.end();
  await runMigrations(pool);
  const audit = new AuditService(new PgAuditRepository(pool));
  const users = new PgAuthRepository(pool);
  const sessions = new SessionsService(new PgSessionsRepository(pool), users, audit);
  const auth = new AuthService(users, audit, sessions);
  app = createApp({ authService: auth, sessionsService: sessions });
  // probe app exists only in tests, to exercise requireAuth
  probe = express();
  probe.use(helmet());
  probe.use(express.json());
  probe.get("/__probe", requireAuth, (req, res) => res.json({ sub: req.user?.sub }));
  probe.use(errorHandler);
  await request(app).post("/auth/register").send({ email: EMAIL, password: PASSWORD });
});

afterAll(async () => {
  await poolEnd();
});

describe("POST /auth/login", () => {
  it("returns 200 with access + refresh tokens", async () => {
    const res = await request(app).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it("returns the identical 401 body for wrong password and unknown email", async () => {
    const wrong = await request(app).post("/auth/login").send({ email: EMAIL, password: "Wrong!Passw0rd1" });
    const unknown = await request(app).post("/auth/login").send({ email: "nobody@example.com", password: "Wrong!Passw0rd1" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("invalid_credentials");
  });
});

describe("requireAuth", () => {
  it("rejects malformed Authorization headers with 401", async () => {
    for (const header of ["Bearer", "Bearer ", "Token abc", "garbage", "Bearer invalid.token.here"]) {
      const res = await request(probe).get("/__probe").set("Authorization", header);
      expect(res.status).toBe(401);
    }
    const missing = await request(probe).get("/__probe");
    expect(missing.status).toBe(401);
  });
});
