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
import { PgSessionsRepository } from "./modules/sessions/sessions.pg-repository";
import { SessionsService } from "./modules/sessions/sessions.service";
import { sessionsRoutes } from "./modules/sessions/sessions.routes";
import { PgMfaRepository } from "./modules/mfa/mfa.pg-repository";
import { MfaService } from "./modules/mfa/mfa.service";
import { mfaRoutes } from "./modules/mfa/mfa.routes";

export interface AppDeps {
  authService: AuthService;
  sessionsService: SessionsService;
  mfaService: MfaService;
}

function realDeps(): AppDeps {
  const pool = getPool();
  const audit = new AuditService(new PgAuditRepository(pool));
  const users = new PgAuthRepository(pool);
  const sessionsService = new SessionsService(new PgSessionsRepository(pool), users, audit);
  const mfaService = new MfaService(new PgMfaRepository(pool), users, sessionsService, audit);
  return { authService: new AuthService(users, audit, sessionsService), sessionsService, mfaService };
}

export function createApp(deps?: Partial<AppDeps>): express.Express {
  const { authService, sessionsService, mfaService } = { ...realDeps(), ...deps };
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

  app.use("/auth", authRoutes(authService, mfaService));
  app.use("/auth", sessionsRoutes(sessionsService));
  app.use("/mfa", mfaRoutes(mfaService));

  app.use((_req, _res, next) => next(new NotFoundError("Ruta no encontrada")));
  app.use(errorHandler);
  return app;
}
