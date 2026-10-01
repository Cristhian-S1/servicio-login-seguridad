import { afterAll, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgAuditRepository } from "../../src/modules/audit/audit.pg-repository";

const pool = new (newDb().adapters.createPg().Pool)();

async function migrate(): Promise<void> {
  const dir = join(__dirname, "../../src/shared/db/migrations");
  for (const f of ["001_users.sql", "002_audit.sql"]) {
    await pool.query(readFileSync(join(dir, f), "utf-8"));
  }
}

afterAll(async () => {
  await pool.end();
});

describe("PgAuditRepository", () => {
  it("persists the event with nullable user_id", async () => {
    await migrate();
    const repo = new PgAuditRepository(pool);
    await repo.append({
      event_type: "register",
      user_id: null,
      actor_ip: "9.9.9.9",
      metadata: { email: "x@example.com" },
      occurred_at: new Date("2026-01-01T00:00:00Z"),
    });
    const { rows } = await pool.query("SELECT event_type, user_id, actor_ip FROM audit_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: "register", user_id: null, actor_ip: "9.9.9.9" });
  });
});
