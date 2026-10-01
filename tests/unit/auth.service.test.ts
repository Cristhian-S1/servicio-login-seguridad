import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/modules/auth/auth.service";
import { registerSchema } from "../../src/modules/auth/auth.schema";
import { AuditService } from "../../src/modules/audit/audit.service";
import { ConflictError } from "../../src/shared/errors";
import type { SessionsService } from "../../src/modules/sessions/sessions.service";
import type { AuthRepository, NewUser } from "../../src/modules/auth/auth.repository";

process.env.ARGON_MEMORY_KIB ??= "1024";
process.env.ARGON_TIME ??= "1";
process.env.ARGON_PARALLELISM ??= "1";

function setup(existing: Array<{ email: string }> = []) {
  const users: Array<{ id: string; email: string; password_hash: string }> = existing.map((u, i) => ({
    id: `id-${i}`,
    email: u.email,
    password_hash: "hash",
  }));
  const repo: AuthRepository = {
    findByEmail: vi.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    findById: vi.fn(async () => null),
    create: vi.fn(async (input: NewUser) => {
      const row = { id: `id-${users.length}`, email: input.email, password_hash: input.password_hash };
      users.push(row);
      return row;
    }),
    setMfaEnabled: vi.fn(async () => {}),
  };
  const audit = new AuditService({ append: vi.fn(async () => {}) });
  const sessions = { createSession: vi.fn(), refresh: vi.fn(), logout: vi.fn() } as unknown as SessionsService;
  return { svc: new AuthService(repo, audit, sessions), audit, users };
}

describe("AuthService.register", () => {
  it("normalizes the email and returns id + email", async () => {
    const { svc } = setup();
    const out = await svc.register({ email: "  User@X.com ", password: "Str0ng!Passw0rd" });
    expect(out.email).toBe("user@x.com");
    expect(out.id).toBeDefined();
    expect(out).not.toHaveProperty("password_hash");
  });

  it("throws ConflictError on duplicate email", async () => {
    const { svc } = setup([{ email: "dup@example.com" }]);
    await expect(svc.register({ email: "dup@example.com", password: "Str0ng!Passw0rd" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects weak passwords at the schema", () => {
    expect(registerSchema.safeParse({ email: "a@example.com", password: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ email: "a@example.com", password: "alllowercaseletters" }).success).toBe(false);
  });
});
