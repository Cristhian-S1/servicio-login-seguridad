import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "../../src/shared/http/errorHandler";
import { sanitize } from "../../src/shared/logger";

function res() {
  const r = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  return {
    state: r,
    res: {
      status: vi.fn(function (this: unknown, code: number) {
        r.statusCode = code;
        return this;
      }),
      json: vi.fn((b: unknown) => {
        r.body = b;
      }),
      setHeader: vi.fn((k: string, v: string) => {
        r.headers[k] = v;
      }),
    } as unknown as Response,
  };
}

describe("no-leak contract", () => {
  it("a 500 never exposes stack or internals", () => {
    const { state, res: response } = res();
    errorHandler(new Error("sql: SELECT * FROM users -- boom"), {} as Request, response, (() => {}) as NextFunction);
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({ error: { code: "internal_error", message: "Error interno" } });
  });

  it("sanitize redacts secrets at any depth", () => {
    const out = sanitize({
      email: "a@example.com",
      password: "x",
      nested: { token: "y", code: "z", ok: 1 },
      AUTHORIZATION: "Bearer abc",
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      email: "a@example.com",
      password: "[REDACTED]",
      AUTHORIZATION: "[REDACTED]",
    });
    expect(out.nested).toMatchObject({ token: "[REDACTED]", code: "[REDACTED]", ok: 1 });
  });
});
