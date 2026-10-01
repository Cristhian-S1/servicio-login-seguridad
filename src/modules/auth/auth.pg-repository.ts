import type { Db } from "../../shared/db/pool";
import type { AuthRepository, NewUser } from "./auth.repository";
import type { User } from "./auth.types";

const COLUMNS = "id, email, password_hash, role, is_active, mfa_enabled";

function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: String(row.email),
    password_hash: String(row.password_hash),
    role: row.role === "admin" ? "admin" : "user",
    is_active: Boolean(row.is_active),
    mfa_enabled: Boolean(row.mfa_enabled),
  };
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email]);
    return rows.length === 0 ? null : toUser(rows[0]);
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows.length === 0 ? null : toUser(rows[0]);
  }

  async create(input: NewUser) {
    const { rows } = await this.db.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, password_hash",
      [input.id, input.email, input.password_hash],
    );
    return { id: String(rows[0].id), email: String(rows[0].email), password_hash: String(rows[0].password_hash) };
  }
}
