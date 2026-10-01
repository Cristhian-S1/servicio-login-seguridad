import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler";
import { loginSchema, registerSchema } from "./auth.schema";
import { mfaVerifySchema } from "../mfa/mfa.schema";
import type { AuthService } from "./auth.service";
import type { MfaService } from "../mfa/mfa.service";

export function authRoutes(auth: AuthService, mfa: MfaService): Router {
  const router = Router();

  router.post(
    "/register",
    asyncHandler(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const user = await auth.register(input);
      res.status(201).json(user);
    }),
  );

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const input = loginSchema.parse(req.body);
      const out = await auth.login({ ...input, ip: req.ip ?? null });
      res.status(200).json(out);
    }),
  );

  router.post(
    "/mfa/verify",
    asyncHandler(async (req, res) => {
      const input = mfaVerifySchema.parse(req.body);
      const out = await mfa.verifyTicket(input.ticket, input.code, req.ip ?? null);
      res.status(200).json(out);
    }),
  );

  return router;
}
