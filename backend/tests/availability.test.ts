import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  AvailabilityService,
} from "../src/services/availabilityService.js";

import {
  loadHotelData,
} from "../src/services/hotelKnowledge.js";

/**
 * AvailabilityService tests
 *
 * These tests verify deterministic business rules.
 *
 * The LLM is NOT involved here.
 *
 * Test flow:
 *
 *   input
 *     ↓
 *   Zod validation
 *     ↓
 *   calendar validation
 *     ↓
 *   date rules
 *     ↓
 *   capacity rules
 *     ↓
 *   room-type filtering
 *     ↓
 *   mock inventory rules
 *     ↓
 *   deterministic result
 */
describe(
  "AvailabilityService",
  () => {
    /**
     * AvailabilityService depends on hotel.json.
     *
     * In the real application this is loaded during
     * server startup. These unit tests bypass index.ts,
     * so load the same trusted data before the suite.
     */
    beforeAll(() => {
      loadHotelData();
    });

    // =====================================================
    // HAPPY PATH
    // =====================================================

    describe("happy path", () => {
      it(
        "returns available rooms for valid dates and 2 adults",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
            });

          expect(result.available).toBe(true);

          expect(
            result.rooms.length,
          ).toBeGreaterThan(0);

          expect(result.checkIn).toBe(
            "2026-10-10",
          );

          expect(result.checkOut).toBe(
            "2026-10-12",
          );

          expect(result.adults).toBe(2);

          expect(result.message).toMatch(
            /found .* room option/i,
          );
        },
      );

      it(
        "returns room metadata from the trusted hotel knowledge",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
            });

          expect(result.available).toBe(true);

          for (const room of result.rooms) {
            expect(room.id).toBeTruthy();
            expect(room.name).toBeTruthy();

            expect(
              room.maxOccupancy,
            ).toBeGreaterThan(0);

            expect(
              room.pricePerNight,
            ).toBeGreaterThanOrEqual(0);

            expect(
              room.currency,
            ).toBeTruthy();

            expect(
              Array.isArray(room.beds),
            ).toBe(true);

            expect(
              room.availableRooms,
            ).toBeGreaterThan(0);
          }
        },
      );

      it(
        "filters results by roomType",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
              roomType: "Executive Suite",
            });

          expect(result.available).toBe(true);

          expect(result.rooms.length).toBeGreaterThan(0);

          for (const room of result.rooms) {
            expect(
              room.name.toLowerCase(),
            ).toContain("executive");
          }
        },
      );

      it(
        "supports matching a room by room id",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
              roomType: "exec",
            });

          expect(result.available).toBe(true);

          expect(result.rooms).toHaveLength(1);

          expect(result.rooms[0]?.id).toBe(
            "exec",
          );
        },
      );

      it(
        "normalizes roomType whitespace and casing",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
              roomType: "  executive suite  ",
            });

          expect(result.available).toBe(true);

          expect(result.rooms).toHaveLength(1);

          expect(result.rooms[0]?.id).toBe(
            "exec",
          );
        },
      );

      it(
        "returns unavailable when roomType matches nothing",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
              roomType: "Presidential Penthouse",
            });

          expect(result.available).toBe(false);

          expect(result.rooms).toHaveLength(0);

          expect(result.message).toMatch(
            /Presidential Penthouse/i,
          );
        },
      );
    });

    // =====================================================
    // CAPACITY
    // =====================================================

    describe("capacity constraints", () => {
      it(
        "excludes rooms below requested occupancy",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 3,
            });

          expect(result.available).toBe(true);

          expect(result.rooms.length).toBeGreaterThan(
            0,
          );

          for (const room of result.rooms) {
            expect(
              room.maxOccupancy,
            ).toBeGreaterThanOrEqual(3);
          }

          const hasDeluxe =
            result.rooms.some(
              (room) =>
                room.id === "deluxe",
            );

          expect(hasDeluxe).toBe(false);
        },
      );

      it(
        "allows rooms exactly matching requested occupancy",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 4,
            });

          expect(result.available).toBe(true);

          expect(result.rooms.length).toBeGreaterThan(
            0,
          );

          for (const room of result.rooms) {
            expect(
              room.maxOccupancy,
            ).toBeGreaterThanOrEqual(4);
          }
        },
      );

      it(
        "returns unavailable when no room can accommodate the party",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 6,
            });

          expect(result.available).toBe(false);

          expect(result.rooms).toHaveLength(0);

          expect(result.message).toMatch(
            /no room can accommodate/i,
          );
        },
      );

      it(
        "never returns a room with zero available inventory",
        async () => {
          const result =
            await AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
            });

          expect(result.available).toBe(true);

          for (const room of result.rooms) {
            expect(
              room.availableRooms,
            ).toBeGreaterThan(0);
          }
        },
      );
    });

    // =====================================================
    // DATE VALIDATION
    // =====================================================

    describe("date validation", () => {
      it(
        "rejects checkOut before checkIn",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-15",
              checkOut: "2026-10-10",
              adults: 2,
            }),
          ).rejects.toThrow(
            /checkOut date must be after checkIn date/i,
          );
        },
      );

      it(
        "rejects checkOut equal to checkIn",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-10",
              adults: 2,
            }),
          ).rejects.toThrow(
            /checkOut date must be after checkIn date/i,
          );
        },
      );

      it(
        "rejects a checkIn date in the past",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2020-01-01",
              checkOut: "2020-01-03",
              adults: 2,
            }),
          ).rejects.toThrow(
            /in the past/i,
          );
        },
      );

      it(
        "rejects an invalid calendar date such as February 31",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-02-31",
              checkOut: "2026-03-02",
              adults: 2,
            }),
          ).rejects.toThrow(
            /Invalid checkIn date/i,
          );
        },
      );

      it(
        "rejects an invalid month",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-13-01",
              checkOut: "2026-13-03",
              adults: 2,
            }),
          ).rejects.toThrow(
            /Invalid checkIn date/i,
          );
        },
      );

      it(
        "rejects an invalid day",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-32",
              checkOut: "2026-11-02",
              adults: 2,
            }),
          ).rejects.toThrow(
            /Invalid checkIn date/i,
          );
        },
      );

      it(
        "rejects dates that do not use YYYY-MM-DD",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "10/10/2026",
              checkOut: "2026-10-12",
              adults: 2,
            }),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects a malformed checkOut date",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "October 12, 2026",
              adults: 2,
            }),
          ).rejects.toThrow();
        },
      );
    });

    // =====================================================
    // PARTY SIZE VALIDATION
    // =====================================================

    describe("party size validation", () => {
      it(
        "rejects zero adults",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 0,
            }),
          ).rejects.toThrow(
            /at least 1 adult/i,
          );
        },
      );

      it(
        "rejects negative adults",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: -1,
            }),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects more than 6 adults",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 7,
            }),
          ).rejects.toThrow(
            /maximum 6 adults/i,
          );
        },
      );

      it(
        "rejects fractional adults",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2.5,
            }),
          ).rejects.toThrow(
            /integer/i,
          );
        },
      );

      it(
        "rejects a non-number adults value",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: "2",
            }),
          ).rejects.toThrow();
        },
      );
    });

    // =====================================================
    // RUNTIME INPUT VALIDATION
    // =====================================================

    describe("runtime input validation", () => {
      it(
        "rejects missing checkIn",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkOut: "2026-10-12",
              adults: 2,
            }),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects missing checkOut",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              adults: 2,
            }),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects missing adults",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
            }),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects null input",
        async () => {
          await expect(
            AvailabilityService.checkAvailability(
              null,
            ),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects non-object input",
        async () => {
          await expect(
            AvailabilityService.checkAvailability(
              "invalid input",
            ),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects an empty object",
        async () => {
          await expect(
            AvailabilityService.checkAvailability(
              {},
            ),
          ).rejects.toThrow();
        },
      );

      it(
        "rejects an empty roomType",
        async () => {
          await expect(
            AvailabilityService.checkAvailability({
              checkIn: "2026-10-10",
              checkOut: "2026-10-12",
              adults: 2,
              roomType: "   ",
            }),
          ).rejects.toThrow(
            /roomType cannot be empty/i,
          );
        },
      );
    });

    // =====================================================
    // FULLY BOOKED MOCK DATA
    // =====================================================

    describe(
      "fully booked mock dates",
      () => {
        it(
          "returns unavailable when the stay includes the fully-booked date",
          async () => {
            const result =
              await AvailabilityService.checkAvailability({
                checkIn: "2026-12-30",
                checkOut: "2027-01-01",
                adults: 2,
              });

            expect(result.available).toBe(
              false,
            );

            expect(result.rooms).toHaveLength(
              0,
            );

            expect(result.message).toMatch(
              /no rooms are available/i,
            );
          },
        );

        it(
          "treats checkout date as non-overnight",
          async () => {
            const result =
              await AvailabilityService.checkAvailability({
                checkIn: "2026-12-29",
                checkOut: "2026-12-31",
                adults: 2,
              });

            expect(result.available).toBe(
              false,
            );
          },
        );

        it(
          "does not mark a stay as fully booked when checkout is the fully-booked date",
          async () => {
            const result =
              await AvailabilityService.checkAvailability({
                checkIn: "2026-12-29",
                checkOut: "2026-12-30",
                adults: 2,
              });

            expect(result.available).toBe(
              true,
            );

            expect(
              result.rooms.length,
            ).toBeGreaterThan(0);
          },
        );
      },
    );
  },
);