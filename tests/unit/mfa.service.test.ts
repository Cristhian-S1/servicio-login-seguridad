import { describe, expect, it, vi } from "vitest";
import { MfaService } from "../../src/modules/mfa/mfa.service";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthError } from "../../src/shared/errors";
import { issueMfaTicket } from "../../src/shared/crypto/jwt";
import { generateSecret, generateCode } from "../../src/shared/crypto/totp";
import type { MfaRepository } from "../../src/modules/mfa/mfa.repository";
import type { AuthRepository } from "../../src/modules/auth/auth.repository";
import type { SessionsService } from "../../src/modules/sessions/sessions.service";
import type { User } from "../../src/modules/auth/auth.types";

process.env.JWT_SECRET ??= "d".repeat(32);

function setup() {
  let secret: string | null = null;
  const codes: Array<{ id: string; code_hash: string; salt: string; used: boolean }> = [];
  let mfaEnabled = false;
  const repo: MfaRepository = {
    getSecret: vi.fn(async (_userId: string) => (secret === null ? null : { secret })),
    saveSecret: vi.fn(async (_userId: string, s: string) => {
      secret = s;
    }),
    setRecoveryHashes: vi.fn(async (_userId: string, hashes: Array<{ code_hash: string; salt: string }>) => {
      codes.length = 0;
      hashes.forEach((h, i) => codes.push({ id: `rc-${i}`, ...h, used: false }));
    }),
    findUnusedRecovery: vi.fn(async (_userId: string) => codes.filter((c) => !c.used)),
    markRecoveryUsed: vi.fn(async (id: string) => {
      const c = codes.find((x) => x.id === id);
      if (c) c.used = true;
    }),
  };
  const users = {
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(async (): Promise<User | null> => ({
      id: "u-1",
      email: "u@example.com",
      password_hash: "h",
      role: "user" as const,
      is_active: true,
      mfa_enabled: mfaEnabled,
    })),
    create: vi.fn(async () => {
      throw new Error("not used");
    }),
    setMfaEnabled: vi.fn(async (_id: string, v: boolean) => {
      mfaEnabled = v;
    }),
  } as unknown as AuthRepository;
  const sessions = {
    createSession: vi.fn(async () => ({ refreshToken: "RAW" })),
    refresh: vi.fn(),
    logout: vi.fn(),
  } as unknown as SessionsService;
  const audit = new AuditService({ append: vi.fn(async () => {}) });
  const record = vi.spyOn(audit, "record");
  const svc = new MfaService(repo, users, sessions, audit);
  return { svc, record, codes, sessions, isEnabled: () => mfaEnabled };
}

describe("MfaService", () => {
  it("setup returns an otpauth url with the secret", async () => {
    const { svc } = setup();
    const out = await svc.setup("u-1");
    expect(out.secret).toBeDefined();
    expect(out.otpauthUrl).toContain("otpauth://totp/");
    expect(out.otpauthUrl).toContain(out.secret);
  });

  it("confirm with a valid code enables mfa and returns 10 recovery codes", async () => {
    const { svc, isEnabled, record } = setup();
    const { secret } = await svc.setup("u-1");
    const { recoveryCodes } = await svc.confirm("u-1", generateCode(secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(isEnabled()).toBe(true);
  });

  it("confirm revokes pre-MFA sessions so old refresh tokens cannot upgrade to mfa:true", async () => {
    const { svc, sessions } = setup();
    const { secret } = await svc.setup("u-1");
    await svc.confirm("u-1", generateCode(secret));
    expect(sessions.logout).toHaveBeenCalledWith("u-1");
  });

  it("confirm with a wrong code throws AuthError and audits mfa_failure", async () => {
    const { svc, record, isEnabled } = setup();
    await svc.setup("u-1");
    await expect(svc.confirm("u-1", "000000")).rejects.toBeInstanceOf(AuthError);
    expect(isEnabled()).toBe(false);
    expect(record).toHaveBeenCalledWith("mfa_failure", expect.anything());
  });

  it("a recovery code works once", async () => {
    const { svc } = setup();
    expect(await svc.consumeRecoveryCode("u-1", "nope")).toBe(false);
    const { secret } = await svc.setup("u-1");
    const { recoveryCodes } = await svc.confirm("u-1", generateCode(secret));
    expect(await svc.consumeRecoveryCode("u-1", recoveryCodes[0])).toBe(true);
    expect(await svc.consumeRecoveryCode("u-1", recoveryCodes[0])).toBe(false);
  });

  it("verifyTicket with a valid code returns tokens", async () => {
    const { svc } = setup();
    const { secret } = await svc.setup("u-1");
    await svc.confirm("u-1", generateCode(secret));
    const out = await svc.verifyTicket(issueMfaTicket("u-1"), generateCode(secret), null);
    expect(out.accessToken).toBeDefined();
    expect(out.refreshToken).toBe("RAW");
  });

  it("verifyTicket with a wrong code throws and audits", async () => {
    const { svc, record } = setup();
    await svc.setup("u-1");
    await expect(svc.verifyTicket(issueMfaTicket("u-1"), "000000", null)).rejects.toBeInstanceOf(AuthError);
    expect(record).toHaveBeenCalledWith("mfa_failure", expect.anything());
  });

  it("accepts codes with +-30s clock drift, rejects +-90s", async () => {
    vi.useFakeTimers();
    try {
      const secret = generateSecret();
      const now = Date.now();
      vi.setSystemTime(now + 30_000);
      const driftedOk = generateCode(secret);
      vi.setSystemTime(now + 90_000);
      const driftedBad = generateCode(secret);
      vi.setSystemTime(now);
      const { checkCode } = await import("../../src/shared/crypto/totp");
      expect(checkCode(secret, driftedOk)).toBe(true);
      expect(checkCode(secret, driftedBad)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
