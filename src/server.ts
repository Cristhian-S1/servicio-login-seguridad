import { createApp } from "./app";
import { loadEnv } from "./config/env";
import { closeDb } from "./shared/db/sqlite";
import { logger } from "./shared/logger";

const env = loadEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`servicio-login listening on port ${env.PORT}`, { env: env.NODE_ENV });
});

function shutdown(signal: string): void {
  logger.info(`received ${signal}, shutting down`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
