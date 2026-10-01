import jwt from "jsonwebtoken";
import { z } from "zod";

export interface AccessClaims {
  sub: string;
  role: "user" | "admin";
  mfa: boolean;
}

export interface MfaTicketClaims {
  sub: string;
  scope: "mfa";
}

const jwtEnvSchema = z.object({
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TTL_MINUTES: z.coerce.number().int().positive().default(15),
});

let cached: { secret: string; accessTtlMinutes: number } | undefined;

function config() {
  if (!cached) {
    const parsed = jwtEnvSchema.safeParse(process.env);
    if (!parsed.success) throw new Error("Invalid environment: JWT_SECRET missing or too short");
    cached = { secret: parsed.data.JWT_SECRET, accessTtlMinutes: parsed.data.ACCESS_TTL_MINUTES };
  }
  return cached;
}

export function signAccessToken(claims: AccessClaims): string {
  const { secret, accessTtlMinutes } = config();
  return jwt.sign({ ...claims }, secret, { algorithm: "HS256", expiresIn: `${accessTtlMinutes}m` });
}

export function issueMfaTicket(userId: string): string {
  return jwt.sign({ sub: userId, scope: "mfa" }, config().secret, { algorithm: "HS256", expiresIn: "5m" });
}

export function verifyToken(token: string): Record<string, unknown> {
  return jwt.verify(token, config().secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
}
