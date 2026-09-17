import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import logger from "../core/logger.js";

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  history: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1).max(4000),
    })
  ).max(20).optional(),
});

const AvailabilityRequestSchema = z.object({
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkIn must be YYYY-MM-DD"),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkOut must be YYYY-MM-DD"),
  adults: z.number().int().min(1).max(6),
  roomType: z.string().optional(),
});

export function validateChatRequest(req: Request, res: Response, next: NextFunction): void {
  const requestId = `req_${randomUUID()}`;
  const result = ChatRequestSchema.safeParse(req.body);
  if (!result.success) {
    logger.warn({ err: result.error, body: req.body }, "Chat request validation failed");
    res.status(400).json({
      error: "Invalid request body",
      details: result.error.flatten().fieldErrors,
      requestId,
    });
    return;
  }
  req.body = result.data;
  next();
}

export function validateAvailabilityRequest(req: Request, res: Response, next: NextFunction): void {
  const requestId = `req_${randomUUID()}`;
  const result = AvailabilityRequestSchema.safeParse(req.body);
  if (!result.success) {
    logger.warn({ err: result.error, body: req.body }, "Availability request validation failed");
    res.status(400).json({
      error: "Invalid request body",
      details: result.error.flatten().fieldErrors,
      requestId,
    });
    return;
  }
  req.body = result.data;
  next();
}