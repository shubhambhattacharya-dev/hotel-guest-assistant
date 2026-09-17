import "./core/env.js";

import logger from "./core/logger.js";
import { loadHotelData } from "./services/hotelKnowledge.js";
import { initializeLangfuse } from "./services/langfuse.js";
import { createApp } from "./app.js";

initializeLangfuse();

const PORT = Number(process.env.PORT ?? 8000);
if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

try {
  loadHotelData();
} catch (error: unknown) {
  logger.fatal({ err: error }, "Failed to load hotel knowledge. Server cannot start.");
  process.exit(1);
}

const app = createApp();

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, environment: process.env.NODE_ENV ?? "development" }, "Backend server started");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown signal received");
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error during server shutdown");
      process.exit(1);
    }
    logger.info("Server shut down gracefully");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));