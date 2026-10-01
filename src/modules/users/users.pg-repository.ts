import type { Db } from "../../shared/db/pool";
import type { UsersRepository } from "./users.repository";
import type { ProfileUser } from "./users.types";

const COLUMNS = "id, email, role, mfa_enabled";

function toProfile(row: Record<string, unknown>): ProfileUser {
  return {
    id: String(row.id),
    email: String(row.email),
    role: row.role === "admin" ? "admin" : "user",
    mfa_enabled: Boolean(row.mfa_enabled),
  };
}

export class PgUsersRepository implements UsersRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<ProfileUser | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows.length === 0 ? null : toProfile(rows[0]);
  }

  async list(): Promise<ProfileUser[]> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM users ORDER BY created_at`);
    return rows.map(toProfile);
  }
}
