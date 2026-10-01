import type { RecoveryHash, StoredRecovery } from "./mfa.types";

export interface MfaRepository {
  getSecret(userId: string): Promise<{ secret: string } | null>;
  saveSecret(userId: string, secret: string): Promise<void>;
  setRecoveryHashes(userId: string, hashes: RecoveryHash[]): Promise<void>;
  findUnusedRecovery(userId: string): Promise<StoredRecovery[]>;
  markRecoveryUsed(id: string): Promise<void>;
}
