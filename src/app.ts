import express from "express";
import helmet from "helmet";
import { NotFoundError } from "./shared/errors";
import { asyncHandler } from "./shared/http/asyncHandler";
import { errorHandler } from "./shared/http/errorHandler";
import { requestId } from "./shared/http/requestId";
import { getPool } from "./shared/db/pool";
import { PgAuditRepository } from "./modules/audit/audit.pg-repository";
import { AuditService } from "./modules/audit/audit.service";
import { PgAuthRepository } from "./modules/auth/auth.pg-repository";
import { AuthService } from "./modules/auth/auth.service";
import { authRoutes } from "./modules/auth/auth.routes";

export interface AppDeps {
  authService: AuthService;
}

function realDeps(): AppDeps {
  const pool = getPool();
  const audit = new AuditService(new PgAuditRepository(pool));
  return { authService: new AuthService(new PgAuthRepository(pool), audit) };
}

export function createApp(deps?: Partial<AppDeps>): express.Express {
  const { authService } = { ...realDeps(), ...deps };
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));
  app.use(requestId);

  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      res.status(200).json({ status: "ok" });
    }),
  );

  app.use("/auth", authRoutes(authService));

  app.use((_req, _res, next) => next(new NotFoundError("Ruta no encontrada")));
  app.use(errorHandler);
  return app;
}
