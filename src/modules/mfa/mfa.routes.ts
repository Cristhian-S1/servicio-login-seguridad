import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler";
import { requireAuth } from "../../shared/http/requireAuth";
import { mfaCodeSchema } from "./mfa.schema";
import type { MfaService } from "./mfa.service";

export function mfaRoutes(service: MfaService): Router {
  const router = Router();

  router.post(
    "/setup",
    requireAuth,
    asyncHandler(async (req, res) => {
      const out = await service.setup(req.user!.sub);
      res.status(200).json(out);
    }),
  );

  router.post(
    "/confirm",
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = mfaCodeSchema.parse(req.body);
      const out = await service.confirm(req.user!.sub, input.code);
      res.status(200).json(out);
    }),
  );

  return router;
}
