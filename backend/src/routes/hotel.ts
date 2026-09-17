import { Router, type Request, type Response } from "express";
import { getHotelDataOrThrow } from "../services/hotelKnowledge.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const hotelData = getHotelDataOrThrow();

  res.status(200).json({
    property: hotelData.property,
    rooms: hotelData.rooms,
    amenities: hotelData.amenities,
    services: hotelData.services ?? [],
    policies: hotelData.policies,
    faqs: hotelData.faqs,
  });
});

export default router;
