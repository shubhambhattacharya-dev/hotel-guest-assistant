import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import logger from "../core/logger.js";
import type { HotelData } from "../types/hotel.js";

/**
 * Runtime schemas
 *
 * TypeScript interfaces provide compile-time safety.
 * Zod provides runtime validation for hotel.json.
 */

const BedSchema = z.object({
  type: z.string().min(1),
  count: z.number().int().positive(),
});

const AddressSchema = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  zip: z.string().min(1),
  country: z.string().min(1),
  lat: z.number().finite().optional(),
  lng: z.number().finite().optional(),
});

const ContactSchema = z.object({
  phone: z.string().min(1),
  email: z.string().email(),
});

const AccessibilityInfoSchema = z.object({
  wheelchairAccessible: z.boolean(),
  accessibleRooms: z.array(z.string()),
  features: z.array(z.string()),
}).optional();

const TransportationInfoSchema = z.object({
  airportDistanceKm: z.number().finite().positive(),
  airportShuttleAvailable: z.boolean(),
  airportShuttleFeePerNight: z.number().finite().nonnegative(),
  parkingCapacity: z.number().int().positive(),
}).optional();

const IncidentalsHoldSchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().min(1),
}).optional();

const PropertySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  address: AddressSchema,
  contact: ContactSchema,
  checkInTime: z.string().min(1),
  checkOutTime: z.string().min(1),
  timezone: z.string().min(1),
  currency: z.string().min(1),
  starRating: z.number().int().positive().optional(),
  totalRooms: z.number().int().positive().optional(),
  yearBuilt: z.number().int().positive().optional(),
  yearRenovated: z.number().int().positive().optional(),
  languagesSpoken: z.array(z.string()).optional(),
  accessibility: AccessibilityInfoSchema,
  transportation: TransportationInfoSchema,
  paymentMethods: z.array(z.string()).optional(),
  incidentalsHold: IncidentalsHoldSchema,
  keywords: z.array(z.string()),
});

const RoomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  maxOccupancy: z.number().int().positive(),
  beds: z.array(BedSchema).min(1),
  pricePerNight: z.number().finite().nonnegative(),
  currency: z.string().min(1),
  sizeSqm: z.number().finite().positive(),
  breakfastIncluded: z.boolean(),
  breakfastAddOnPerPersonPerDay: z.number().finite().nonnegative(),
  image: z.string().optional(),
  view: z.string().optional(),
  badge: z.string().optional(),
  description: z.string().min(1),
  features: z.array(z.string()),
  keywords: z.array(z.string()),
});

const AmenitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
  keywords: z.array(z.string()),
});

const ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  keywords: z.array(z.string()),
});

const PolicySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  policy: z.string().min(1),
  rules: z.record(z.string(), z.unknown()).optional(),
  keywords: z.array(z.string()),
});

const FaqSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  relatedPolicyId: z.string().optional(),
  relatedAmenityId: z.string().optional(),
  relatedRoomIds: z.array(z.string()).optional(),
  keywords: z.array(z.string()),
});

const MetaSchema = z.object({
  version: z.string().min(1),
  lastUpdated: z.string().min(1),
  generatedFor: z.string().min(1),
});

const HotelDataSchema = z.object({
  meta: MetaSchema.optional(),
  property: PropertySchema,
  rooms: z.array(RoomSchema),
  amenities: z.array(AmenitySchema),
  services: z.array(ServiceSchema).optional(),
  policies: z.array(PolicySchema),
  faqs: z.array(FaqSchema),
});

/**
 * Validated hotel knowledge cache.
 *
 * hotel.json is loaded once per server process.
 * Only validated data is stored here.
 */
let cachedHotelData: HotelData | null = null;

/**
 * Find hotel.json from the supported project layouts.
 */
function findHotelDataPath(): string {
  const candidates = [
    path.join(process.cwd(), "data", "hotel.json"),
    path.join(process.cwd(), "..", "data", "hotel.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `hotel.json could not be found. Checked: ${candidates.join(", ")}`,
  );
}

/**
 * Load, parse, validate, and cache hotel knowledge.
 *
 * Call this once during server startup.
 *
 * Startup should fail when hotel.json is missing,
 * malformed, or does not match the expected schema.
 */
export function loadHotelData(): void {
  const hotelDataPath = findHotelDataPath();

  try {
    const raw = fs.readFileSync(hotelDataPath, "utf-8");

    const parsed: unknown = JSON.parse(raw);

    const validated = HotelDataSchema.parse(parsed);

    cachedHotelData = validated;

       logger.info(
       {
         path: hotelDataPath,
         rooms: validated.rooms.length,
         amenities: validated.amenities.length,
         services: validated.services?.length ?? 0,
         policies: validated.policies.length,
         faqs: validated.faqs.length,
       },
       "Loaded and validated hotel knowledge",
     );
  } catch (error) {
    logger.error(
      {
        err: error,
        path: hotelDataPath,
      },
      "Failed to load and validate hotel knowledge",
    );

    throw error;
  }
}

/**
 * Return cached hotel data.
 *
 * Returns null when startup loading has not completed.
 */
export function getHotelData(): HotelData | null {
  return cachedHotelData;
}

/**
 * Return cached hotel data or fail immediately.
 *
 * Use this inside services that cannot function without
 * hotel knowledge.
 */
export function getHotelDataOrThrow(): HotelData {
  if (!cachedHotelData) {
    throw new Error(
      "Hotel data is not loaded. loadHotelData() must succeed during server startup.",
    );
  }

  return cachedHotelData;
}

/**
 * Check whether validated hotel data is currently loaded.
 */
export function isHotelDataLoaded(): boolean {
  return cachedHotelData !== null;
}