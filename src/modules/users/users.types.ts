export type UserRole = "user" | "admin";

export interface ProfileUser {
  id: string;
  email: string;
  role: UserRole;
  mfa_enabled: boolean;
}
