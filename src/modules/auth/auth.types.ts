export type UserRole = "user" | "admin";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  mfa_enabled: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
}
