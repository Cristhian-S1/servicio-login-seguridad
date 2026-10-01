import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler";
import { registerSchema } from "./auth.schema";
import type { AuthService } from "./auth.service";

export function authRoutes(service: AuthService): Router {
  const router = Router();

  router.post(
    "/register",
    asyncHandler(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const user = await service.register(input);
      res.status(201).json(user);
    }),
  );

  return router;
}
