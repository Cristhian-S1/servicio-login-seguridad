import { getPool, type Db } from "../src/shared/db/pool";
import { runMigrations } from "../src/shared/db/migrate";
import { PgAuthRepository } from "../src/modules/auth/auth.pg-repository";
import { PgSessionsRepository } from "../src/modules/sessions/sessions.pg-repository";
import { PgAuditRepository } from "../src/modules/audit/audit.pg-repository";
import { AuditService } from "../src/modules/audit/audit.service";
import { AuthService } from "../src/modules/auth/auth.service";
import { SessionsService } from "../src/modules/sessions/sessions.service";
import { ConflictError } from "../src/shared/errors";
import { logger } from "../src/shared/logger";

export async function seed(db: Db, password: string): Promise<{ adminEmail: string; userEmail: string }> {
  await runMigrations(db);
  const audit = new AuditService(new PgAuditRepository(db));
  const users = new PgAuthRepository(db);
  const sessions = new SessionsService(new PgSessionsRepository(db), users, audit);
  const auth = new AuthService(users, audit, sessions);

  async function ensure(email: string, role: "user" | "admin"): Promise<void> {
    try {
      await auth.register({ email, password });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
    const row = await users.findByEmail(email);
    if (!row) throw new Error(`seed: ${email} missing after register`);
    if (role === "admin") {
      await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [row.id]);
    }
  }

  await ensure("admin@example.com", "admin");
  await ensure("user@example.com", "user");
  return { adminEmail: "admin@example.com", userEmail: "user@example.com" };
}

async function main(): Promise<void> {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("SEED_PASSWORD is required (min 12 chars, meeting the password policy)");
  }
  const pool = getPool();
  try {
    const out = await seed(pool, password);
    logger.info("seed ok", out);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error("seed failed", { err });
    process.exit(1);
  });
}
