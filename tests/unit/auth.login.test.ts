import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/modules/auth/auth.service";
import { AuthError } from "../../src/shared/errors";
import { verifyToken } from "../../src/shared/crypto/jwt";
import { hashPassword } from "../../src/shared/crypto/password";
import type { AuthRepository } from "../../src/modules/auth/auth.repository";
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

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    email: "user@example.com",
    password_hash: PASSWORD_HASH,
    is_active: true,
    ...overrides,
  };
}

function setup(users: User[]) {
  const repo: AuthRepository = {
    findByEmail: vi.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    findById: vi.fn(async (id: string) => users.find((u) => u.id === id) ?? null),
    create: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  return { svc: new AuthService(repo) };
}

describe("AuthService.login", () => {
  it("returns an access token for valid credentials", async () => {
    const { svc } = setup([makeUser()]);
    const out = await svc.login({ email: "USER@example.com ", password: PASSWORD });
    expect(out.accessToken).toBeDefined();
    expect(verifyToken(out.accessToken)).toMatchObject({ sub: "u-1" });
  });

  it("throws identical AuthError for wrong password and unknown email", async () => {
    const { svc } = setup([makeUser()]);
    const wrong = await svc.login({ email: "user@example.com", password: "Wrong!Passw0rd1" }).catch((e) => e);
    const unknown = await svc.login({ email: "nobody@example.com", password: "Wrong!Passw0rd1" }).catch((e) => e);
    expect(wrong).toBeInstanceOf(AuthError);
    expect(unknown).toBeInstanceOf(AuthError);
    expect({ ...wrong }).toEqual({ ...unknown });
  });

  it("throws AuthError for inactive users", async () => {
    const { svc } = setup([makeUser({ is_active: false })]);
    await expect(svc.login({ email: "user@example.com", password: PASSWORD })).rejects.toBeInstanceOf(AuthError);
  });
});
