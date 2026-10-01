import { describe, expect, it, vi } from "vitest";
import { UsersService } from "../../src/modules/users/users.service";
import { NotFoundError } from "../../src/shared/errors";
import type { UsersRepository } from "../../src/modules/users/users.repository";

function setup() {
  const repo: UsersRepository = {
    findById: vi.fn(async (id: string) =>
      id === "u-1" ? { id, email: "u@example.com", role: "user" as const, mfa_enabled: false } : null,
    ),
    list: vi.fn(async () => [
      { id: "u-1", email: "u@example.com", role: "user" as const, mfa_enabled: false },
    ]),
  };
  return { svc: new UsersService(repo) };
}

describe("UsersService", () => {
  it("getMe returns the profile without secrets", async () => {
    const { svc } = setup();
    const me = await svc.getMe("u-1");
    expect(me).toEqual({ id: "u-1", email: "u@example.com", role: "user", mfa_enabled: false });
    expect(me).not.toHaveProperty("password_hash");
  });

  it("getMe throws NotFoundError for unknown users", async () => {
    const { svc } = setup();
    await expect(svc.getMe("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listUsers returns profiles", async () => {
    const { svc } = setup();
    const list = await svc.listUsers();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("password_hash");
  });
});
