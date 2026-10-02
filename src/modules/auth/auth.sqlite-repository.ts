import type Database from "better-sqlite3";
import type { AuthRepository, NewUser } from "./auth.repository";
import type { User } from "./auth.types";

function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: String(row.email),
    password_hash: String(row.password_hash),
    is_active: Number(row.is_active) === 1,
  };
}

export class SqliteAuthRepository implements AuthRepository {
  constructor(private readonly db: Database.Database) {}

  async findByEmail(email: string): Promise<User | null> {
    const row = this.db.prepare("SELECT id, email, password_hash, is_active FROM users WHERE email = ?").get(email) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : toUser(row);
  }

  async findById(id: string): Promise<User | null> {
    const row = this.db.prepare("SELECT id, email, password_hash, is_active FROM users WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : toUser(row);
  }

  async create(input: NewUser) {
    try {
      this.db
        .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
        .run(input.id, input.email, input.password_hash);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw Object.assign(new Error("duplicate email"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
      }
      throw err;
    }
    return { id: input.id, email: input.email, password_hash: input.password_hash };
  }
}
