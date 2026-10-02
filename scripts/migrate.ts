import { getDb, runMigrations } from "../src/shared/db/sqlite";
import { logger } from "../src/shared/logger";

async function main(): Promise<void> {
  const db = getDb();
  try {
    const fresh = await runMigrations(db);
    logger.info(`migrations applied: ${fresh.length}`, { fresh });
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("migration failed", { err });
  process.exit(1);
});
