import type { NextFunction, Request, Response } from "express";
import { AuthError } from "../errors";
import { verifyToken } from "../crypto/jwt";

export interface RequestUser {
  sub: string;
  role: "user" | "admin";
  mfa: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: RequestUser;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    next(new AuthError());
    return;
  }
  try {
    const payload = verifyToken(token);
    if (typeof payload.sub !== "string") throw new AuthError();
    req.user = {
      sub: payload.sub,
      role: payload.role === "admin" ? "admin" : "user",
      mfa: payload.mfa === true,
    };
    next();
  } catch (err) {
    next(err instanceof AuthError ? err : new AuthError());
  }
}
