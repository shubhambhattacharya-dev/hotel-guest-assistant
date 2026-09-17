import { z } from "zod";
import logger from "../core/logger.js";
import { getHotelDataOrThrow } from "./hotelKnowledge.js";
import type { Room } from "../types/hotel.js";

/**
 * Runtime input schema.
 *
 * Tool/API input is untrusted runtime data.
 * Zod validates it before any business logic runs.
 */
export const AvailabilityInputSchema = z.object({
  checkIn: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      "checkIn must be YYYY-MM-DD",
    ),

  checkOut: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      "checkOut must be YYYY-MM-DD",
    ),

  adults: z
    .number()
    .int("adults must be an integer")
    .min(1, "At least 1 adult is required")
    .max(6, "Maximum 6 adults are supported"),

  roomType: z
    .string()
    .trim()
    .min(1, "roomType cannot be empty")
    .optional(),
});

export type AvailabilityInput = z.infer<
  typeof AvailabilityInputSchema
>;

/**
 * Mock dynamic inventory.
 *
 * hotel.json = static room truth
 * INVENTORY = dynamic availability truth
 *
 * In production, replace this with a PMS/booking-provider adapter.
 */
interface InventoryRecord {
  roomId: string;
  availableRooms: number;
}

const INVENTORY: readonly InventoryRecord[] = [
  {
    roomId: "deluxe",
    availableRooms: 5,
  },
  {
    roomId: "exec",
    availableRooms: 3,
  },
  {
    roomId: "family",
    availableRooms: 2,
  },
];

/**
 * Deterministic dates used only for the mock assignment.
 *
 * Any stay containing one of these nights is considered fully booked.
 */
const FULLY_BOOKED_DATES = new Set<string>([
  "2026-12-30",
]);

export interface AvailabilityRoom {
  id: string;
  name: string;
  maxOccupancy: number;
  beds: {
    type: string;
    count: number;
  }[];
  pricePerNight: number;
  currency: string;
  availableRooms: number;
}

export interface AvailabilityResult {
  available: boolean;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: AvailabilityRoom[];
  message: string;
}

/**
 * Parse a validated YYYY-MM-DD string as a UTC date.
 *
 * Defaults satisfy noUncheckedIndexedAccess while remaining
 * defensive if this helper is ever called independently.
 */
function parseDate(date: string): Date {
  const [
    year = 0,
    month = 0,
    day = 0,
  ] = date.split("-").map(Number);

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
    ),
  );
}

/**
 * Validate that a YYYY-MM-DD value is a real calendar date.
 *
 * Examples rejected:
 *   2026-02-31
 *   2026-13-01
 *   2026-00-10
 */
function parseAndValidateDate(
  value: string,
  fieldName: "checkIn" | "checkOut",
): Date {
  const parsed = parseDate(value);

  const normalized = parsed
    .toISOString()
    .slice(0, 10);

  if (
    Number.isNaN(parsed.getTime()) ||
    normalized !== value
  ) {
    throw new Error(
      `Invalid ${fieldName} date: ${value}`,
    );
  }

  return parsed;
}

/**
 * Return today at UTC midnight.
 */
function todayUTC(): Date {
  const now = new Date();

  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  );
}

/**
 * Check whether the requested stay contains
 * any deterministic fully-booked night.
 *
 * Checkout date is excluded because it is not a night of the stay.
 */
function includesFullyBookedDate(
  start: Date,
  end: Date,
): boolean {
  for (
    const current = new Date(start);
    current < end;
    current.setUTCDate(
      current.getUTCDate() + 1,
    )
  ) {
    const date = current
      .toISOString()
      .slice(0, 10);

    if (FULLY_BOOKED_DATES.has(date)) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize text for deterministic room matching.
 */
function normalizeRoomType(
  value: string,
): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Deterministic availability service.
 *
 * LLM:
 *   decides whether the availability tool is appropriate
 *   and proposes tool arguments.
 *
 * Backend:
 *   validates input
 *   enforces date/capacity/type rules
 *   reads trusted hotel knowledge
 *   checks inventory
 *
 * The LLM never calculates or invents availability.
 */
export interface AvailabilityProvider {
  checkAvailability(input: unknown): Promise<AvailabilityResult>;
}

export class AvailabilityService implements AvailabilityProvider {
  public async checkAvailability(input: unknown): Promise<AvailabilityResult> {
    return AvailabilityService.checkAvailability(input);
  }

  public static async checkAvailability(
    input: unknown,
  ): Promise<AvailabilityResult> {
    // 1. Validate untrusted runtime input.
    const {
      checkIn,
      checkOut,
      adults,
      roomType,
    } = AvailabilityInputSchema.parse(input);

    // 2. Validate real calendar dates.
    const start = parseAndValidateDate(
      checkIn,
      "checkIn",
    );

    const end = parseAndValidateDate(
      checkOut,
      "checkOut",
    );

    // 3. Validate stay order.
    if (end <= start) {
      throw new Error(
        "checkOut date must be after checkIn date.",
      );
    }

    // 4. Reject past check-in dates.
    if (start < todayUTC()) {
      throw new Error(
        `checkIn date ${checkIn} is in the past.`,
      );
    }

    // 5. Load validated, cached hotel knowledge.
    const hotelData = getHotelDataOrThrow();

    // 6. Build the inventory lookup once.
    const inventoryByRoomId = new Map<
      string,
      number
    >(
      INVENTORY.map((record) => [
        record.roomId,
        record.availableRooms,
      ]),
    );

    // 7. Join static room metadata with dynamic inventory.
    const rooms = hotelData.rooms
      .map((room: Room) => {
        const availableRooms =
          inventoryByRoomId.get(room.id);

        if (availableRooms === undefined) {
          logger.warn(
            {
              roomId: room.id,
            },
            "Room has no matching inventory record; skipping room",
          );

          return null;
        }

        return {
          ...room,
          availableRooms,
        };
      })
      .filter(
        (
          room: (Room & { availableRooms: number }) | null,
        ): room is Room & { availableRooms: number } => room !== null,
      );

    // 8. Check deterministic date-based mock availability
    // before returning room options.
    if (
      includesFullyBookedDate(
        start,
        end,
      )
    ) {
      return {
        available: false,
        checkIn,
        checkOut,
        adults,
        rooms: [],
        message:
          `No rooms are available for the selected dates ` +
          `(${checkIn} to ${checkOut}).`,
      };
    }

    // 9. Check if any room can accommodate the requested party size.
    const canAccommodateParty = rooms.some(
      (room: Room & { availableRooms: number }) => room.maxOccupancy >= adults,
    );

    if (!canAccommodateParty) {
      return {
        available: false,
        checkIn,
        checkOut,
        adults,
        rooms: [],
        message: `No room can accommodate ${adults} guest(s).`,
      };
    }

    // 10. Apply deterministic occupancy and inventory rules.
    let eligibleRooms = rooms.filter(
      (room: Room & { availableRooms: number }) =>
        room.maxOccupancy >= adults &&
        room.availableRooms > 0,
    );

    // 11. Apply deterministic room-type filtering.
    if (roomType) {
      const query =
        normalizeRoomType(roomType);

      eligibleRooms =
        eligibleRooms.filter((room: Room & { availableRooms: number }) => {
          const roomId =
            normalizeRoomType(room.id);

          const roomName =
            normalizeRoomType(room.name);

          return (
            roomId === query ||
            roomName === query ||
            roomName.includes(query)
          );
        });
    }

    // 12. No matching room.
    if (eligibleRooms.length === 0) {
      return {
        available: false,
        checkIn,
        checkOut,
        adults,
        rooms: [],
        message: roomType
          ? `No ${roomType} room is available for ${adults} guest(s).`
          : `No room is available for ${adults} guest(s).`,
      };
    }

    // 13. Return deterministic tool output.
    const availableRooms: AvailabilityRoom[] =
      eligibleRooms.map((room) => ({
        id: room.id,
        name: room.name,
        maxOccupancy:
          room.maxOccupancy,
        beds: room.beds,
        pricePerNight:
          room.pricePerNight,
        currency: room.currency,
        availableRooms:
          room.availableRooms,
      }));

    logger.info(
      {
        checkIn,
        checkOut,
        adults,
        roomType,
        resultCount:
          availableRooms.length,
      },
      "Availability check completed",
    );

    return {
      available: true,
      checkIn,
      checkOut,
      adults,
      rooms: availableRooms,
      message:
        `Found ${availableRooms.length} room option(s) ` +
        `for ${adults} guest(s).`,
    };
  }
}

export const defaultAvailabilityProvider: AvailabilityProvider =
  new AvailabilityService();