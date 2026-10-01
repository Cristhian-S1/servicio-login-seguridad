import { randomBytes, randomUUID, createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { AuthError } from "../../shared/errors";
import { signAccessToken } from "../../shared/crypto/jwt";
import type { AuthRepository } from "../auth/auth.repository";
import type { SessionsRepository } from "./sessions.repository";

const REFRESH_TTL_MS = Number(process.env.REFRESH_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000;
/** Reuse of a token revoked within this window is treated as a concurrent
 *  race (fail closed, family survives). Older reuse means likely theft. */
const RACE_WINDOW_MS = 10_000;

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class SessionsService {
  constructor(
    private readonly repo: SessionsRepository,
    private readonly users: Pick<AuthRepository, "findById">,
    private readonly audit: AuditService,
  ) {}

  async createSession(userId: string, ip: string | null): Promise<{ refreshToken: string }> {
    const refreshToken = randomBytes(32).toString("base64url");
    await this.repo.save({
      id: randomUUID(),
      user_id: userId,
      token_hash: hashRefreshToken(refreshToken),
      expires_at: new Date(Date.now() + REFRESH_TTL_MS),
      ip,
    });
    return { refreshToken };
  }

  async refresh(rawToken: string, ip: string | null): Promise<{ accessToken: string; refreshToken: string }> {
    const hash = hashRefreshToken(rawToken);
    const newId = randomUUID();
    const newRaw = randomBytes(32).toString("base64url");
    const rotated = await this.repo.rotate(hash, newId);
    if (rotated) {
      await this.repo.save({
        id: newId,
        user_id: rotated.user_id,
        token_hash: hashRefreshToken(newRaw),
        expires_at: new Date(Date.now() + REFRESH_TTL_MS),
        ip,
      });
      await this.audit.record("refresh", { userId: rotated.user_id, ip });
      return { accessToken: await this.accessFor(rotated.user_id), refreshToken: newRaw };
    }
    const row = await this.repo.findByHash(hash);
    if (!row) throw new AuthError();
    if (row.expires_at <= new Date()) {
      await this.repo.revoke(row.id);
      throw new AuthError();
    }
    if (row.revoked_at !== null) {
      const ageMs = Date.now() - row.revoked_at.getTime();
      if (ageMs > RACE_WINDOW_MS) {
        await this.repo.revokeFamily(row.user_id);
        await this.audit.record("refresh_reuse_detected", { userId: row.user_id, ip });
      }
      throw new AuthError();
    }
    throw new AuthError();
  }

  async logout(userId: string): Promise<void> {
    await this.repo.revokeFamily(userId);
  }

  private async accessFor(userId: string): Promise<string> {
    const user = await this.users.findById(userId);
    if (!user || !user.is_active) throw new AuthError();
    return signAccessToken({ sub: user.id, role: user.role, mfa: user.mfa_enabled });
  }
}
