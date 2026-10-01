import type { ProfileUser } from "./users.types";

export interface UsersRepository {
  findById(id: string): Promise<ProfileUser | null>;
  list(): Promise<ProfileUser[]>;
}
