import { getPool } from "../src/shared/db/pool";
import { runMigrations } from "../src/shared/db/migrate";
import { logger } from "../src/shared/logger";

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const fresh = await runMigrations(pool);
    logger.info(`migrations applied: ${fresh.length}`, { fresh });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error("migration failed", { err });
  process.exit(1);
});
