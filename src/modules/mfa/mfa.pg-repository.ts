import { randomUUID } from "node:crypto";
import type { Db } from "../../shared/db/pool";
import type { MfaRepository } from "./mfa.repository";
import type { RecoveryHash, StoredRecovery } from "./mfa.types";

export class PgMfaRepository implements MfaRepository {
  constructor(private readonly db: Db) {}

  async getSecret(userId: string): Promise<{ secret: string } | null> {
    const { rows } = await this.db.query("SELECT secret FROM mfa_secrets WHERE user_id = $1", [userId]);
    return rows.length === 0 ? null : { secret: String(rows[0].secret) };
  }

  async saveSecret(userId: string, secret: string): Promise<void> {
    await this.db.query(
      `INSERT INTO mfa_secrets (user_id, secret) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, last_used_at = NULL`,
      [userId, secret],
    );
  }

  async setRecoveryHashes(userId: string, hashes: RecoveryHash[]): Promise<void> {
    await this.db.query("DELETE FROM recovery_codes WHERE user_id = $1", [userId]);
    for (const h of hashes) {
      await this.db.query("INSERT INTO recovery_codes (id, user_id, code_hash, salt) VALUES ($1, $2, $3, $4)", [
        randomUUID(),
        userId,
        h.code_hash,
        h.salt,
      ]);
    }
  }

  async findUnusedRecovery(userId: string): Promise<StoredRecovery[]> {
    const { rows } = await this.db.query(
      "SELECT id, code_hash, salt FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL",
      [userId],
    );
    return rows.map((r) => ({ id: String(r.id), code_hash: String(r.code_hash), salt: String(r.salt) }));
  }

  async markRecoveryUsed(id: string): Promise<void> {
    await this.db.query("UPDATE recovery_codes SET used_at = now() WHERE id = $1", [id]);
  }
}
