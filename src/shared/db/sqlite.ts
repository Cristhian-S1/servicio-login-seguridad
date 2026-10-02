import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadEnv } from "../../config/env";

export const MIGRATIONS_DIR = join(__dirname, "migrations");

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!db) {
    const env = loadEnv();
    const file = resolve(env.DB_PATH);
    mkdirSync(dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

export function runMigrations(target: Database.Database, dir: string = MIGRATIONS_DIR): string[] {
  target.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const done = new Set(
    (target.prepare("SELECT filename FROM schema_migrations").all() as Array<{ filename: string }>).map(
      (r) => r.filename,
    ),
  );
  const fresh: string[] = [];
  const migrate = target.transaction((file: string, sql: string) => {
    target.exec(sql);
    target.prepare("INSERT INTO schema_migrations (filename) VALUES (?)").run(file);
  });
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (done.has(file)) continue;
    migrate(file, readFileSync(join(dir, file), "utf-8"));
    fresh.push(file);
  }
  return fresh;
}
