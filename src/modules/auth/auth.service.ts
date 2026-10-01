import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { ConflictError } from "../../shared/errors";
import { hashPassword } from "../../shared/crypto/password";
import type { AuthRepository } from "./auth.repository";
import type { PublicUser } from "./auth.types";
import type { RegisterInput } from "./auth.schema";

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly audit: AuditService,
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
}
