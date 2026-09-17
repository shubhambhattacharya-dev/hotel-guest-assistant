import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import logger from "../core/logger.js";
import { AvailabilityService } from "../services/availabilityService.js";
import { validateAvailabilityRequest } from "../middleware/validation.js";

const router = Router();

router.post("/", validateAvailabilityRequest, async (req: Request, res: Response): Promise<void> => {
  const requestId = `req_${randomUUID()}`;

  try {
    if (
      typeof req.body !== "object" ||
      req.body === null ||
      Array.isArray(req.body)
    ) {
      throw new Error(
        "Request body must be a JSON object. Send Content-Type: application/json with a JSON body.",
      );
    }

    const result = await AvailabilityService.checkAvailability(req.body);

    logger.info(
      {
        requestId,
        checkIn: result.checkIn,
        checkOut: result.checkOut,
        adults: result.adults,
        available: result.available,
        roomCount: result.rooms.length,
      },
      "Availability check completed",
    );

    res.status(200).json({
      ...result,
      requestId,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Invalid availability parameters";

    logger.warn(
      {
        requestId,
        err: error,
      },
      "Availability request rejected",
    );

    res.status(400).json({
      error: errorMessage,
      requestId,
    });
  }
});

export default router;
