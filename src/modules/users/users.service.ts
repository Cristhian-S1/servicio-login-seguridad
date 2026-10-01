import { NotFoundError } from "../../shared/errors";
import type { UsersRepository } from "./users.repository";
import type { ProfileUser } from "./users.types";

export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  async getMe(id: string): Promise<ProfileUser> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError("Usuario no encontrado");
    return user;
  }

  async listUsers(): Promise<ProfileUser[]> {
    return this.repo.list();
  }
}
