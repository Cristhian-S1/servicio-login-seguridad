import type { PublicUser, User } from "./auth.types";

export interface NewUser {
  id: string;
  email: string;
  password_hash: string;
}

export interface AuthRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  create(input: NewUser): Promise<PublicUser & { password_hash: string }>;
  setMfaEnabled(id: string, enabled: boolean): Promise<void>;
}
