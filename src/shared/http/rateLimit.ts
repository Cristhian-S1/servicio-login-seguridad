import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { RateLimitError } from "../errors";

export interface LimiterOpts {
  max: number;
  windowMs: number;
}

function handler(windowMs: number) {
  return (_req: unknown, _res: unknown, next: (err: unknown) => void) => {
    next(new RateLimitError(Math.ceil(windowMs / 1000)));
  };
}

function fromEnv(prefix: "LOGIN" | "GLOBAL", defaults: LimiterOpts): LimiterOpts {
  return {
    max: Number(process.env[`RATE_LIMIT_${prefix}_MAX`] ?? defaults.max),
    windowMs: Number(process.env[`RATE_LIMIT_${prefix}_WINDOW_MS`] ?? defaults.windowMs),
  };
}

/** Counts per IP + normalized email: one attacker's list doesn't lock out others. */
export function loginLimiter(opts: LimiterOpts = fromEnv("LOGIN", { max: 5, windowMs: 15 * 60 * 1000 })) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${String(req.body?.email ?? "").trim().toLowerCase()}`,
    handler: handler(opts.windowMs),
    standardHeaders: false,
    legacyHeaders: false,
  });
}

/** Counts per IP: MFA tickets rotate, so the email key would be useless here. */
export function mfaVerifyLimiter(opts: LimiterOpts = fromEnv("LOGIN", { max: 5, windowMs: 15 * 60 * 1000 })) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
    handler: handler(opts.windowMs),
    standardHeaders: false,
    legacyHeaders: false,
  });
}

export function globalLimiter(
  opts: LimiterOpts = fromEnv("GLOBAL", { max: 100, windowMs: 15 * 60 * 1000 }),
) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
    handler: handler(opts.windowMs),
    standardHeaders: false,
    legacyHeaders: false,
  });
}
