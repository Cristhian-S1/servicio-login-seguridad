import type { NewRefreshToken, RefreshTokenRow } from "./sessions.types";

export interface SessionsRepository {
  save(input: NewRefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRow | null>;
  revoke(id: string, replacedBy?: string | null): Promise<void>;
  revokeFamily(userId: string): Promise<void>;
  /**
   * Atomically revokes a live, unexpired token (single statement, safe under
   * concurrency). Returns the revoked row, or null when the token is missing,
   * expired, or already revoked.
   */
  rotate(tokenHash: string, replacedBy: string): Promise<RefreshTokenRow | null>;
}
