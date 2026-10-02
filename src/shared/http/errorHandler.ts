import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, InternalError, RateLimitError, ValidationError } from "../errors";
import { logger } from "../logger";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof RateLimitError) {
    res.setHeader("Retry-After", String(err.retryAfterSeconds));
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
    });
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const body = new ValidationError("Datos invalidos", details);
    res.status(body.statusCode).json({ error: { code: body.code, message: body.message, details } });
    return;
  }

  if (err instanceof SyntaxError && "body" in (err as unknown as Record<string, unknown>)) {
    const body = new ValidationError("Cuerpo JSON invalido");
    res.status(body.statusCode).json({ error: { code: body.code, message: body.message } });
    return;
  }

  const bodyStatus = (err as { status?: unknown }).status;
  const bodyType = (err as { type?: unknown }).type;
  if (
    typeof bodyStatus === "number" &&
    (bodyStatus === 400 || bodyStatus === 413) &&
    (err instanceof SyntaxError || typeof bodyType === "string")
  ) {
    const message = bodyStatus === 413 ? "Cuerpo demasiado grande" : "Cuerpo JSON invalido";
    res.status(bodyStatus).json({ error: { code: "validation_error", message } });
    return;
  }

  logger.error("unhandled error", { method: req.method, path: req.path, err });
  const fallback = new InternalError();
  res.status(fallback.statusCode).json({ error: { code: fallback.code, message: fallback.message } });
}
