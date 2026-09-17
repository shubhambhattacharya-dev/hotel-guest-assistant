import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttpDefault from "pino-http";
import logger from "./core/logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoHttp = pinoHttpDefault as any;
import { isHotelDataLoaded } from "./services/hotelKnowledge.js";
import { initializeRedis } from "./services/redis.js";
import chatRouter from "./routes/chat.js";
import availabilityRouter from "./routes/availability.js";
import hotelRouter from "./routes/hotel.js";
import { metricsMiddleware, metricsRouter } from "./middleware/metrics.js";

export function createApp() {
  const app = express();

  const allowedOrigins = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
  ]);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return callback(null, true);
        callback(new Error(`CORS policy: Origin ${origin} not allowed`));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "x-request-id"],
      credentials: true,
      optionsSuccessStatus: 204,
    }),
  );

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  app.use(rateLimit({
    windowMs: 60_000,
    max: process.env.NODE_ENV === "production" ? 100 : 1000,
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // pino-http middleware
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  app.use(pinoHttp({ logger }) as express.RequestHandler);
  app.use(express.json({ limit: "1mb" }));
  app.use(metricsMiddleware);

  // Initialize Redis (non-blocking)
  initializeRedis();

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "healthy",
      hotelKnowledgeLoaded: isHotelDataLoaded(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/ready", async (_req: Request, res: Response) => {
    const { checkLLMHealth } = await import("./services/llmClient.js");
    const llmHealthy = await checkLLMHealth();
    res.status(llmHealthy ? 200 : 503).json({
      status: llmHealthy ? "ready" : "degraded",
      hotelKnowledgeLoaded: isHotelDataLoaded(),
      llm: llmHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
    });
  });

  // Mount routes with their specific validation
  app.use("/api/chat", chatRouter);
  app.use("/api/availability", availabilityRouter);
  app.use("/api/hotel", hotelRouter);
  app.use("/metrics", metricsRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "Unhandled application error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}