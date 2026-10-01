import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { AuthError, ValidationError } from "../../shared/errors";
import { signAccessToken, verifyToken } from "../../shared/crypto/jwt";
import { checkCode, generateSecret, newRecoveryCode, otpauthUrl } from "../../shared/crypto/totp";
import type { AuthRepository } from "../auth/auth.repository";
import type { SessionsService } from "../sessions/sessions.service";
import type { MfaRepository } from "./mfa.repository";

const RECOVERY_COUNT = 10;

function hashRecovery(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

export class MfaService {
  constructor(
    private readonly repo: MfaRepository,
    private readonly users: AuthRepository,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  async setup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthError();
    const secret = generateSecret();
    await this.repo.saveSecret(userId, secret);
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  async confirm(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const stored = await this.repo.getSecret(userId);
    if (!stored) throw new ValidationError("Primero inicia el alta con POST /mfa/setup");
    if (!checkCode(stored.secret, code)) {
      await this.audit.record("mfa_failure", { userId });
      throw new AuthError();
    }
    const recoveryCodes = Array.from({ length: RECOVERY_COUNT }, () => newRecoveryCode());
    await this.repo.setRecoveryHashes(
      userId,
      recoveryCodes.map((c) => {
        const salt = randomBytes(16).toString("hex");
        return { salt, code_hash: hashRecovery(c, salt) };
      }),
    );
    await this.users.setMfaEnabled(userId, true);
    await this.audit.record("mfa_enabled", { userId });
    return { recoveryCodes };
  }

  async verifyTicket(ticket: string, code: string, ip: string | null): Promise<{ accessToken: string; refreshToken: string }> {
    let userId: string;
    try {
      const payload = verifyToken(ticket);
      if (typeof payload.sub !== "string" || payload.scope !== "mfa") throw new AuthError();
      userId = payload.sub;
    } catch (err) {
      throw err instanceof AuthError ? err : new AuthError();
    }
    const fail = async (): Promise<never> => {
      await this.audit.record("mfa_failure", { userId, ip });
      throw new AuthError();
    };
    const user = await this.users.findById(userId);
    if (!user || !user.is_active) return fail();
    const stored = await this.repo.getSecret(userId);
    if (stored && checkCode(stored.secret, code)) {
      return this.finish(userId, user.role, ip, "mfa_success");
    }
    if (await this.consumeRecoveryCode(userId, code)) {
      return this.finish(userId, user.role, ip, "mfa_success");
    }
    return fail();
  }

  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const candidates = await this.repo.findUnusedRecovery(userId);
    const match = candidates.find((c) => {
      const a = Buffer.from(hashRecovery(code, c.salt));
      const b = Buffer.from(c.code_hash);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!match) return false;
    await this.repo.markRecoveryUsed(match.id);
    return true;
  }

  private async finish(
    userId: string,
    role: "user" | "admin",
    ip: string | null,
    event: "mfa_success",
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const { refreshToken } = await this.sessions.createSession(userId, ip);
    await this.audit.record(event, { userId, ip });
    return { accessToken: signAccessToken({ sub: userId, role, mfa: true }), refreshToken };
  }
}
