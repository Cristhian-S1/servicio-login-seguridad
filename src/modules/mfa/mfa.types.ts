export interface RecoveryHash {
  code_hash: string;
  salt: string;
}

export interface StoredRecovery {
  id: string;
  code_hash: string;
  salt: string;
}
