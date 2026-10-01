import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler";
import { requireAuth } from "../../shared/http/requireAuth";
import { requireMfa } from "../../shared/http/requireMfa";
import { requireRole } from "../../shared/http/requireRole";
import type { UsersService } from "./users.service";

export function usersRoutes(service: UsersService): Router {
  const router = Router();

  router.get(
    "/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      res.status(200).json(await service.getMe(req.user!.sub));
    }),
  );

  return router;
}

export function adminRoutes(service: UsersService): Router {
  const router = Router();

  router.get(
    "/users",
    requireAuth,
    requireRole("admin"),
    requireMfa,
    asyncHandler(async (_req, res) => {
      res.status(200).json(await service.listUsers());
    }),
  );

  return router;
}
