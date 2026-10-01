import { randomBytes } from "node:crypto";
import { generateSecret as otpSecret, generateSync, generateURI, verifySync } from "otplib";

export function generateSecret(): string {
  return otpSecret();
}

export function otpauthUrl(secret: string, email: string): string {
  return generateURI({ issuer: "servicio-login", label: email, secret });
}

export function generateCode(secret: string): string {
  return generateSync({ secret });
}

export function checkCode(secret: string, code: string): boolean {
  try {
    // epochTolerance 30s == clasica window 1 (±1 paso de 30s)
    return verifySync({ secret, token: code, epochTolerance: 30 }).valid;
  } catch {
    return false;
  }
}

export function newRecoveryCode(): string {
  return randomBytes(9).toString("base64url");
}
