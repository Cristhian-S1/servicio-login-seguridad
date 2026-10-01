import type { NewRefreshToken, RefreshTokenRow } from "./sessions.types";

export interface SessionsRepository {
  save(input: NewRefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRow | null>;
  revoke(id: string, replacedBy?: string | null): Promise<void>;
  revokeFamily(userId: string): Promise<void>;
}
