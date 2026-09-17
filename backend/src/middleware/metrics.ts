import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";
import type { Request, Response, NextFunction } from "express";
import logger from "../core/logger.js";

export const register = new Registry();

collectDefaultMetrics({ register, prefix: "hotel_backend_" });

export const httpRequestsTotal = new Counter({
  name: "hotel_backend_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: "hotel_backend_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const llmRequestsTotal = new Counter({
  name: "hotel_backend_llm_requests_total",
  help: "Total LLM requests",
  labelNames: ["provider", "operation", "status"],
  registers: [register],
});

export const llmRequestDuration = new Histogram({
  name: "hotel_backend_llm_request_duration_seconds",
  help: "LLM request duration in seconds",
  labelNames: ["provider", "operation"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const circuitBreakerState = new Gauge({
  name: "hotel_backend_circuit_breaker_state",
  help: "Circuit breaker state (0=closed, 1=half-open, 2=open)",
  labelNames: ["circuit"],
  registers: [register],
});

export const activeConversations = new Gauge({
  name: "hotel_backend_active_conversations",
  help: "Number of active conversations",
  registers: [register],
});

export const availabilityChecksTotal = new Counter({
  name: "hotel_backend_availability_checks_total",
  help: "Total availability checks",
  labelNames: ["result"],
  registers: [register],
});

function getRoutePattern(req: Request): string {
  return req.route?.path ?? req.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const route = getRoutePattern(req);

  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc({ method: req.method, route, status_code: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route }, duration);
  });

  next();
}

export const metricsRouter = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.set("Content-Type", register.contentType);
    const metrics = await register.metrics();
    res.send(metrics);
  } catch (error) {
    logger.error({ err: error }, "Failed to generate metrics");
    res.status(500).send("Failed to generate metrics");
  }
};