import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

export function requestId(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(REQUEST_ID_HEADER, randomUUID());
  next();
}
