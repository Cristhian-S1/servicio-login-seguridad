import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuthError } from "../../src/shared/errors";
import { verifyToken } from "../../src/shared/crypto/jwt";
import type { SessionsRepository } from "../../src/modules/sessions/sessions.repository";
import type { AuthRepository } from "../../src/modules/auth/auth.repository";
import type { RefreshTokenRow } from "../../src/modules/sessions/sessions.types";
import type { User } from "../../src/modules/auth/auth.types";

process.env.JWT_SECRET ??= "c".repeat(32);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function setup() {
  const rows = new Map<string, RefreshTokenRow>();
  const repo: SessionsRepository = {
    save: vi.fn(async (input) => {
      rows.set(input.token_hash, {
        ...input,
        revoked_at: null,
        replaced_by: null,
        created_at: new Date(),
      });
    }),
    findByHash: vi.fn(async (h: string) => rows.get(h) ?? null),
    revoke: vi.fn(async (id: string, replacedBy: string | null = null) => {
      for (const r of rows.values()) {
        if (r.id === id) {
          r.revoked_at = new Date();
          r.replaced_by = replacedBy;
        }
      }
    }),
    revokeFamily: vi.fn(async (userId: string) => {
      for (const r of rows.values()) {
        if (r.user_id === userId && r.revoked_at === null) r.revoked_at = new Date();
      }
    }),
    rotate: vi.fn(async (hash: string, newId: string) => {
      const r = rows.get(hash) ?? null;
      if (!r || r.revoked_at !== null || r.expires_at <= new Date()) return null;
      r.revoked_at = new Date();
      r.replaced_by = newId;
      return { ...r };
    }),
  };
  const user: User = {
    id: "u-1",
    email: "u@example.com",
    password_hash: "h",
    role: "admin",
    is_active: true,
    mfa_enabled: true,
  };
  const users: AuthRepository = {
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(async () => user),
    create: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  const audit = new AuditService({ append: vi.fn(async () => {}) });
  const record = vi.spyOn(audit, "record");
  return { svc: new SessionsService(repo, users, audit), repo, record, rows };
}

describe("SessionsService", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("createSession persists only the hash", async () => {
    const { svc, rows } = ctx;
    const { refreshToken } = await svc.createSession("u-1", "1.1.1.1");
    expect(refreshToken).toBeDefined();
    expect(rows.get(sha(refreshToken))).toBeDefined();
    expect(rows.get(refreshToken)).toBeUndefined();
  });

  it("refresh rotates: old revoked with replaced_by, new pair issued", async () => {
    const { svc, rows } = ctx;
    const first = await svc.createSession("u-1", null);
    const second = await svc.refresh(first.refreshToken, null);
    expect(second.accessToken).toBeDefined();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const oldRow = rows.get(sha(first.refreshToken));
    expect(oldRow?.revoked_at).toBeInstanceOf(Date);
    expect(oldRow?.replaced_by).toBeDefined();
    const payload = verifyToken(second.accessToken);
    expect(payload).toMatchObject({ sub: "u-1", role: "admin", mfa: true });
  });

  it("refresh of an expired token throws AuthError", async () => {
    const { svc, rows } = ctx;
    const { refreshToken } = await svc.createSession("u-1", null);
    rows.get(sha(refreshToken))!.expires_at = new Date(Date.now() - 1000);
    await expect(svc.refresh(refreshToken, null)).rejects.toBeInstanceOf(AuthError);
  });

  it("refresh of an unknown token throws AuthError", async () => {
    const { svc } = ctx;
    await expect(svc.refresh("nope", null)).rejects.toBeInstanceOf(AuthError);
  });

  it("reuse of an old rotated token nukes the family and audits it", async () => {
    const { svc, rows, repo, record } = ctx;
    const first = await svc.createSession("u-1", null);
    const second = await svc.refresh(first.refreshToken, null);
    const oldRow = rows.get(sha(first.refreshToken))!;
    oldRow.revoked_at = new Date(Date.now() - 3600_000); // stolen long after rotation
    await expect(svc.refresh(first.refreshToken, null)).rejects.toBeInstanceOf(AuthError);
    expect(repo.revokeFamily).toHaveBeenCalledWith("u-1");
    expect(record).toHaveBeenCalledWith("refresh_reuse_detected", expect.objectContaining({ userId: "u-1" }));
    await expect(svc.refresh(second.refreshToken, null)).rejects.toBeInstanceOf(AuthError);
  });

  it("recent reuse (race) fails closed WITHOUT nuking the family", async () => {
    const { svc, repo, record } = ctx;
    const first = await svc.createSession("u-1", null);
    const second = await svc.refresh(first.refreshToken, null);
    await expect(svc.refresh(first.refreshToken, null)).rejects.toBeInstanceOf(AuthError);
    expect(repo.revokeFamily).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalledWith("refresh_reuse_detected", expect.anything());
    const third = await svc.refresh(second.refreshToken, null); // family alive
    expect(third.accessToken).toBeDefined();
  });

  it("logout revokes the family", async () => {
    const { svc, repo } = ctx;
    await svc.logout("u-1");
    expect(repo.revokeFamily).toHaveBeenCalledWith("u-1");
  });
});
