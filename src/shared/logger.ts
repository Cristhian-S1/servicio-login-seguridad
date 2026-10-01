const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set(["password", "token", "secret", "code", "authorization"]);

function isSensitive(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
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
