import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { runMigrations } from "../../src/shared/db/sqlite";
import { verifyToken } from "../../src/shared/crypto/jwt";
import { SqliteAuthRepository } from "../../src/modules/auth/auth.sqlite-repository";
import { AuthService } from "../../src/modules/auth/auth.service";

process.env.DB_PATH ??= ":memory:";
process.env.JWT_SECRET ??= "a".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

const EMAIL = "login@example.com";
const PASSWORD = "Str0ng!Passw0rd";

let app: Express;
let db: Database.Database;

beforeAll(async () => {
  db = new Database(":memory:");
  await runMigrations(db);
  app = createApp({ authService: new AuthService(new SqliteAuthRepository(db)) });
  await request(app).post("/auth/register").send({ email: EMAIL, password: PASSWORD });
});

afterAll(async () => {
  db.close();
});

describe("POST /auth/login", () => {
  it("returns 200 with an access token", async () => {
    const res = await request(app).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(verifyToken(res.body.accessToken)).toMatchObject({ sub: expect.any(String) });
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
