const REDACTED = "[REDACTED]";
// Substrings: cubre refreshToken, accessToken, mfaTicket, recoveryCodes,
// password_hash, authorization y cualquier variante futura con esos nombres.
const SENSITIVE_SUBSTRINGS = ["password", "token", "secret", "code", "auth", "hash", "recovery", "ticket"];

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_SUBSTRINGS.some((s) => lower.includes(s));
}

export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitive(k) ? REDACTED : sanitize(v);
    }
    return out;
  }
  return value;
}

function log(level: "info" | "warn" | "error", message: string, meta?: unknown): void {
  const line = { level, message, ...(meta !== undefined ? { meta: sanitize(meta) } : {}) };
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

export const logger = {
  info: (message: string, meta?: unknown): void => log("info", message, meta),
  warn: (message: string, meta?: unknown): void => log("warn", message, meta),
  error: (message: string, meta?: unknown): void => log("error", message, meta),
};
