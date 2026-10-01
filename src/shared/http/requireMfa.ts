import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../errors";

export function requireMfa(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.mfa !== true) {
    next(new ForbiddenError("mfa_required", "Esta operacion requiere doble factor"));
    return;
  }
  next();
}
