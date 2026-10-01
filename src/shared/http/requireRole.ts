import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../errors";

export function requireRole(role: "admin" | "user") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.user?.role !== role) {
      next(new ForbiddenError("forbidden", "Acceso denegado"));
      return;
    }
    next();
  };
}
