import type { Db } from "../../shared/db/pool";
import type { SessionsRepository } from "./sessions.repository";
import type { NewRefreshToken, RefreshTokenRow } from "./sessions.types";

function toRow(r: Record<string, unknown>): RefreshTokenRow {
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    token_hash: String(r.token_hash),
    expires_at: new Date(String(r.expires_at)),
    revoked_at: r.revoked_at === null ? null : new Date(String(r.revoked_at)),
    replaced_by: r.replaced_by === null ? null : String(r.replaced_by),
    created_at: new Date(String(r.created_at)),
    ip: r.ip === null ? null : String(r.ip),
  };
}

export class PgSessionsRepository implements SessionsRepository {
  constructor(private readonly db: Db) {}

  async save(input: NewRefreshToken): Promise<void> {
    await this.db.query(
      "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip) VALUES ($1, $2, $3, $4, $5)",
      [input.id, input.user_id, input.token_hash, input.expires_at, input.ip],
    );
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    const { rows } = await this.db.query("SELECT * FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);
    return rows.length === 0 ? null : toRow(rows[0]);
  }

  async revoke(id: string, replacedBy: string | null = null): Promise<void> {
    await this.db.query("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [
      id,
      replacedBy,
    ]);
  }

  async revokeFamily(userId: string): Promise<void> {
    await this.db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
      userId,
    ]);
  }

  async rotate(tokenHash: string, replacedBy: string): Promise<RefreshTokenRow | null> {
    const { rows } = await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING *`,
      [tokenHash, replacedBy],
    );
    return rows.length === 0 ? null : toRow(rows[0]);
  }
}
