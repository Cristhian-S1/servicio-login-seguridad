import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { AuthError, ConflictError } from "../../shared/errors";
import { hashPassword, verifyPassword } from "../../shared/crypto/password";
import { issueMfaTicket, signAccessToken } from "../../shared/crypto/jwt";
import type { AuthRepository } from "./auth.repository";
import type { SessionsService } from "../sessions/sessions.service";
import type { PublicUser } from "./auth.types";
import type { LoginInput, RegisterInput } from "./auth.schema";

export type LoginResult = { accessToken: string; refreshToken: string } | { mfaRequired: true; mfaTicket: string };

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
  ) {}

  async register(input: RegisterInput): Promise<PublicUser> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.repo.findByEmail(email);
    if (existing) throw new ConflictError("email_taken", "Ese email ya esta registrado");
    let created;
    try {
      created = await this.repo.create({
        id: randomUUID(),
        email,
        password_hash: await hashPassword(input.password),
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError("email_taken", "Ese email ya esta registrado");
      }
      throw err;
    }
    await this.audit.record("register", { userId: created.id });
    return { id: created.id, email: created.email };
  }

  async login(input: LoginInput & { ip?: string | null }): Promise<LoginResult> {
    const fail = async (userId?: string): Promise<never> => {
      await this.audit.record("login_failure", { userId, ip: input.ip ?? null });
      throw new AuthError();
    };
    const email = input.email.trim().toLowerCase();
    const user = await this.repo.findByEmail(email);
    if (!user || !user.is_active) return fail(user?.id);
    if (!(await verifyPassword(user.password_hash, input.password))) return fail(user.id);
    if (user.mfa_enabled) {
      return { mfaRequired: true, mfaTicket: issueMfaTicket(user.id) };
    }
    if (!this.sessions) throw new AuthError();
    const { refreshToken } = await this.sessions.createSession(user.id, input.ip ?? null);
    await this.audit.record("login_success", { userId: user.id, ip: input.ip ?? null });
    return {
      accessToken: signAccessToken({ sub: user.id, role: user.role, mfa: false }),
      refreshToken,
    };
  }
}
