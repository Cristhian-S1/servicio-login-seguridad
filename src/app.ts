import express from "express";
import helmet from "helmet";
import { NotFoundError } from "./shared/errors";
import { asyncHandler } from "./shared/http/asyncHandler";
import { errorHandler } from "./shared/http/errorHandler";
import { requestId } from "./shared/http/requestId";

export function createApp(): express.Express {
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

  app.use((_req, _res, next) => next(new NotFoundError("Ruta no encontrada")));
  app.use(errorHandler);
  return app;
}
