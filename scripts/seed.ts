import type Database from "better-sqlite3";
import { getDb, runMigrations } from "../src/shared/db/sqlite";
import { SqliteAuthRepository } from "../src/modules/auth/auth.sqlite-repository";
import { AuthService } from "../src/modules/auth/auth.service";
import { ConflictError } from "../src/shared/errors";
import { logger } from "../src/shared/logger";

export async function seed(db: Database.Database, password: string): Promise<{ email: string }> {
  await runMigrations(db);
  const auth = new AuthService(new SqliteAuthRepository(db));
  const email = "demo@example.com";
  try {
    await auth.register({ email, password });
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
  }
  return { email };
}

async function main(): Promise<void> {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("SEED_PASSWORD is required (min 12 chars, meeting the password policy)");
  }
  const db = getDb();
  try {
    const out = await seed(db, password);
    logger.info("seed ok", out);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error("seed failed", { err });
    process.exit(1);
  });
}
