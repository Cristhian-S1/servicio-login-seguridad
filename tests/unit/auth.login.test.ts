import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/modules/auth/auth.service";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthError } from "../../src/shared/errors";
import { verifyToken } from "../../src/shared/crypto/jwt";
import { hashPassword } from "../../src/shared/crypto/password";
import type { AuthRepository } from "../../src/modules/auth/auth.repository";
import type { SessionsRepository } from "../../src/modules/sessions/sessions.repository";
import type { User } from "../../src/modules/auth/auth.types";

process.env.JWT_SECRET ??= "b".repeat(32);
process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

const PASSWORD = "Str0ng!Passw0rd";
let PASSWORD_HASH = "";

beforeEach(async () => {
  if (!PASSWORD_HASH) PASSWORD_HASH = await hashPassword(PASSWORD);
});

function setup(users: User[]) {
  const repo: AuthRepository = {
    findByEmail: vi.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    findById: vi.fn(async (id: string) => users.find((u) => u.id === id) ?? null),
    create: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  const sessions: SessionsRepository = {
    save: vi.fn(async () => {}),
    findByHash: vi.fn(async () => null),
    revoke: vi.fn(async () => {}),
    revokeFamily: vi.fn(async () => {}),
  };
  const audit = new AuditService({ append: vi.fn(async () => {}) });
  const record = vi.spyOn(audit, "record");
  return { svc: new AuthService(repo, audit, sessions), sessions, record };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    email: "user@example.com",
    password_hash: PASSWORD_HASH,
    role: "user",
    is_active: true,
    mfa_enabled: false,
    ...overrides,
  };
}

describe("AuthService.login", () => {
  it("returns access + refresh tokens and persists only the hash", async () => {
    const { svc, sessions } = setup([makeUser()]);
    const out = await svc.login({ email: "USER@example.com ", password: PASSWORD, ip: "1.1.1.1" });
    expect(out).toHaveProperty("accessToken");
    expect(out).toHaveProperty("refreshToken");
    expect(sessions.save).toHaveBeenCalledOnce();
    const saved = (sessions.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.token_hash).not.toContain((out as { refreshToken: string }).refreshToken);
  });

  it("throws identical AuthError for wrong password and unknown email", async () => {
    const { svc, record } = setup([makeUser()]);
    const wrong = await svc.login({ email: makeUser().email, password: "Wrong!Passw0rd1", ip: null }).catch((e) => e);
    const unknown = await svc.login({ email: "nobody@example.com", password: "Wrong!Passw0rd1", ip: null }).catch((e) => e);
    expect(wrong).toBeInstanceOf(AuthError);
    expect(unknown).toBeInstanceOf(AuthError);
    expect({ ...wrong }).toEqual({ ...unknown });
    expect(record).toHaveBeenCalledWith("login_failure", expect.anything());
  });

  it("throws AuthError for inactive users", async () => {
    const { svc } = setup([makeUser({ is_active: false })]);
    await expect(svc.login({ email: makeUser().email, password: PASSWORD, ip: null })).rejects.toBeInstanceOf(AuthError);
  });

  it("returns an mfa ticket when mfa is enabled", async () => {
    const { svc } = setup([makeUser({ mfa_enabled: true })]);
    const out = await svc.login({ email: makeUser().email, password: PASSWORD, ip: null });
    expect(out).toHaveProperty("mfaRequired", true);
    const payload = verifyToken((out as { mfaTicket: string }).mfaTicket);
    expect(payload).toMatchObject({ sub: "u-1", scope: "mfa" });
  });
});
