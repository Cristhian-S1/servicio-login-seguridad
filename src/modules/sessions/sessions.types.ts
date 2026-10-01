export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  created_at: Date;
  ip: string | null;
}

export interface NewRefreshToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  ip: string | null;
}
