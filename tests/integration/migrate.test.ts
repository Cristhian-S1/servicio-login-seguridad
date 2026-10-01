import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { runMigrations } from "../../src/shared/db/migrate";

function memDb() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

describe("runMigrations", () => {
  it("creates the users table with a unique email", async () => {
    const pool = memDb();
    try {
      await runMigrations(pool);
      await pool.query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
        ["11111111-1111-1111-1111-111111111111", "a@example.com", "hash"],
      );
      await expect(
        pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
          "22222222-2222-2222-2222-222222222222",
          "a@example.com",
          "hash",
        ]),
      ).rejects.toMatchObject({ code: "23505" });
      const applied = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
      expect(applied.rows.map((r) => r.filename)).toContain("001_users.sql");
    } finally {
      await pool.end();
    }
  });
});
