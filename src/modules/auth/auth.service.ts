import { randomUUID } from "node:crypto";
import { AuthError, ConflictError } from "../../shared/errors";
import { hashPassword, verifyPassword } from "../../shared/crypto/password";
import { signAccessToken } from "../../shared/crypto/jwt";
import type { AuthRepository } from "./auth.repository";
import type { PublicUser } from "./auth.types";
import type { LoginInput, RegisterInput } from "./auth.schema";

const DUPLICATE_CODES = new Set(["23505", "SQLITE_CONSTRAINT_UNIQUE"]);

export class AuthService {
  constructor(private readonly repo: AuthRepository) {}

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
      if (DUPLICATE_CODES.has((err as { code?: string }).code ?? "")) {
        throw new ConflictError("email_taken", "Ese email ya esta registrado");
      }
      throw err;
    }
    return { id: created.id, email: created.email };
  }

  async login(input: LoginInput): Promise<{ accessToken: string }> {
    const email = input.email.trim().toLowerCase();
    const user = await this.repo.findByEmail(email);
    if (!user || !user.is_active) throw new AuthError();
    if (!(await verifyPassword(user.password_hash, input.password))) throw new AuthError();
    return { accessToken: signAccessToken({ sub: user.id }) };
  }
}
