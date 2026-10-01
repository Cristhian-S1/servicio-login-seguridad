import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler";
import { requireAuth } from "../../shared/http/requireAuth";
import { refreshSchema } from "./sessions.schema";
import type { SessionsService } from "./sessions.service";

export function sessionsRoutes(service: SessionsService): Router {
  const router = Router();

  router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
      const input = refreshSchema.parse(req.body);
      const out = await service.refresh(input.refresh_token, req.ip ?? null);
      res.status(200).json(out);
    }),
  );

  router.post(
    "/logout",
    requireAuth,
    asyncHandler(async (req, res) => {
      await service.logout(req.user!.sub);
      res.status(204).end();
    }),
  );

  return router;
}
