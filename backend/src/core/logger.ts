import pino from "pino";

/**
 * Centralized structured logger for the backend.
 *
 * Development:
 *   Human-readable pretty logs.
 *
 * Production:
 *   JSON logs suitable for log aggregators such as
 *   CloudWatch, Datadog, or similar systems.
 *
 * This is a real Pino instance so it can also be used
 * directly by pino-http.
 */

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",

  // Keep logs structured in production.
  // Use pretty output locally for easier development.
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }),

  // Serialize Error objects passed through { err }.
  serializers: {
    err: pino.stdSerializers.err,
  },

  // ISO-8601 timestamps.
  timestamp: pino.stdTimeFunctions.isoTime,

  // Fields included on every application log.
  base: {
    service: "hotel-backend",
  },
});

export default logger;