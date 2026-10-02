import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./pool";

export const MIGRATIONS_DIR = join(__dirname, "migrations");

export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  try {
    await db.query(
      "CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
  } catch (err) {
    // 42P07 = duplicate_table (real PG). pg-mem omite el code y manda solo el mensaje.
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code !== "42P07" && !/already exists/i.test(message)) throw err;
  }
  const applied = await db.query("SELECT filename FROM schema_migrations");
  const done = new Set(applied.rows.map((r) => String(r.filename)));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const fresh: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf-8");
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
    fresh.push(file);
  }
  return fresh;
}
