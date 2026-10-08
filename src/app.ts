import { join } from "node:path";
import express from "express";
import helmet from "helmet";
import { NotFoundError } from "./shared/errors";
import { asyncHandler } from "./shared/http/asyncHandler";
import { errorHandler } from "./shared/http/errorHandler";
import { requestId } from "./shared/http/requestId";
import { getDb } from "./shared/db/sqlite";
import { SqliteAuthRepository } from "./modules/auth/auth.sqlite-repository";
import { AuthService } from "./modules/auth/auth.service";
import { authRoutes } from "./modules/auth/auth.routes";
import swaggerUi from "swagger-ui-express";
import { openapiSpec } from "./docs/openapi";

export interface AppDeps {
  authService: AuthService;
}

function realDeps(): AppDeps {
  return { authService: new AuthService(new SqliteAuthRepository(getDb())) };
}

export function createApp(deps?: Partial<AppDeps>): express.Express {
  const { authService } = { ...realDeps(), ...deps };
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));
  app.use(requestId);
  app.use(express.static(join(__dirname, "..", "public")));

  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      res.status(200).json({ status: "ok" });
    }),
  );

  app.get("/docs.json", (_req, res) => {
    res.status(200).json(openapiSpec);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.use("/auth", authRoutes(authService));

  app.use((_req, _res, next) => next(new NotFoundError("Ruta no encontrada")));
  app.use(errorHandler);
  return app;
}
