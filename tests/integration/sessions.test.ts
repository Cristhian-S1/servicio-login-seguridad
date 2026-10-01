import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/migrate";
import { PgAuthRepository } from "../../src/modules/auth/auth.pg-repository";
import { PgSessionsRepository } from "../../src/modules/sessions/sessions.pg-repository";
import { PgAuditRepository } from "../../src/modules/audit/audit.pg-repository";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthService } from "../../src/modules/auth/auth.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/login";
process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

const EMAIL = "sess@example.com";
const PASSWORD = "Str0ng!Passw0rd";

let app: Express;
let poolEnd: () => Promise<void>;

async function registerAndLogin(email: string) {
  await request(app).post("/auth/register").send({ email, password: PASSWORD });
  const login = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  return login.body.refreshToken as string;
}

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
});

afterAll(async () => {
  await poolEnd();
});

describe("POST /auth/refresh", () => {
  it("rotates the pair and kills the old token", async () => {
    const first = await registerAndLogin("rot@example.com");
    const res = await request(app).post("/auth/refresh").send({ refresh_token: first });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.refreshToken).not.toBe(first);
    const reuse = await request(app).post("/auth/refresh").send({ refresh_token: first });
    expect(reuse.status).toBe(401);
  });

  it("immediate reuse fails closed but the family survives (race path)", async () => {
    const first = await registerAndLogin("nuke@example.com");
    const second = (await request(app).post("/auth/refresh").send({ refresh_token: first })).body.refreshToken;
    const reuse = await request(app).post("/auth/refresh").send({ refresh_token: first });
    expect(reuse.status).toBe(401);
    const after = await request(app).post("/auth/refresh").send({ refresh_token: second });
    expect(after.status).toBe(200); // no nuke: reuse was recent (old-theft nuke is unit-tested with aged rows)
  });

  it("concurrent double-use: exactly one succeeds, family survives", async () => {
    const first = await registerAndLogin("race@example.com");
    const [a, b] = await Promise.all([
      request(app).post("/auth/refresh").send({ refresh_token: first }),
      request(app).post("/auth/refresh").send({ refresh_token: first }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    const winner = a.status === 200 ? a.body.refreshToken : b.body.refreshToken;
    const again = await request(app).post("/auth/refresh").send({ refresh_token: winner });
    expect(again.status).toBe(200);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the family: refresh afterwards is 401", async () => {
    const first = await registerAndLogin("out@example.com");
    const login = await request(app).post("/auth/login").send({ email: "out@example.com", password: PASSWORD });
    const res = await request(app).post("/auth/logout").set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(204);
    const after = await request(app).post("/auth/refresh").send({ refresh_token: first });
    expect(after.status).toBe(401);
  });
});
