import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { loadHotelData } from "../src/services/hotelKnowledge.js";

describe("Backend API Integration Tests", () => {
  let app: Express;

  /**
   * Mirrors real application startup without:
   * - binding a network port
   * - registering process signal handlers
   * - starting a real HTTP server
   *
   * createApp() should remain a pure application factory.
   */
  beforeAll(() => {
    loadHotelData();
    app = createApp();
  });

  // =====================================================
  // 1. HEALTH CHECK
  // =====================================================

  describe("GET /health", () => {
    it("returns 200 and confirms hotel knowledge is loaded", async () => {
      const res = await request(app)
        .get("/health");

      expect(res.status).toBe(200);

      expect(res.body).toMatchObject({
        status: "healthy",
        hotelKnowledgeLoaded: true,
      });

      expect(res.body.timestamp).toBeTruthy();
      expect(typeof res.body.timestamp).toBe("string");
    });
  });

  // =====================================================
  // 2. AVAILABILITY API
  //
  // Fully deterministic.
  // No LLM is involved.
  // Exact business behavior can safely be asserted.
  // =====================================================

  describe("POST /api/availability", () => {
    it("returns available rooms for a valid request", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 2,
        });

      expect(res.status).toBe(200);

      expect(res.body.available).toBe(true);

      expect(Array.isArray(res.body.rooms)).toBe(true);

      expect(res.body.rooms.length).toBeGreaterThan(0);

      expect(res.body).toMatchObject({
        checkIn: "2026-10-10",
        checkOut: "2026-10-12",
        adults: 2,
      });

      expect(res.body).toHaveProperty("message");
      expect(res.body).toHaveProperty("requestId");

      expect(typeof res.body.requestId).toBe("string");
      expect(res.body.requestId.length).toBeGreaterThan(0);

      for (const room of res.body.rooms) {
        expect(room.id).toBeTruthy();
        expect(room.name).toBeTruthy();

        expect(
          room.maxOccupancy,
        ).toBeGreaterThanOrEqual(2);

        expect(
          room.pricePerNight,
        ).toBeGreaterThanOrEqual(0);

        expect(
          room.availableRooms,
        ).toBeGreaterThan(0);

        expect(
          Array.isArray(room.beds),
        ).toBe(true);
      }
    });

    it("filters rooms by capacity", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 3,
        });

      expect(res.status).toBe(200);

      expect(res.body.available).toBe(true);

      expect(res.body.rooms.length).toBeGreaterThan(0);

      for (const room of res.body.rooms) {
        expect(
          room.maxOccupancy,
        ).toBeGreaterThanOrEqual(3);
      }

      const deluxeReturned =
        res.body.rooms.some(
          (room: { id: string }) =>
            room.id === "deluxe",
        );

      expect(deluxeReturned).toBe(false);
    });

    it("filters rooms by room type", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 2,
          roomType: "exec",
        });

      expect(res.status).toBe(200);

      expect(res.body.available).toBe(true);

      expect(res.body.rooms.length).toBeGreaterThan(0);

      for (const room of res.body.rooms) {
        expect(room.id).toBe("exec");
      }
    });

    it("returns unavailable when no room can fit the requested party", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 6,
        });

      expect(res.status).toBe(200);

      expect(res.body.available).toBe(false);

      expect(res.body.rooms).toEqual([]);

      expect(res.body.message).toBeTruthy();

      expect(res.body).toHaveProperty("requestId");
    });

    it("returns 400 for malformed input", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "not-a-date",
          checkOut: "2026-10-12",
          adults: -1,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty("error");

      expect(typeof res.body.error).toBe("string");

      expect(res.body).toHaveProperty(
        "requestId",
      );
    });

    it("returns 400 when checkout is before check-in", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-15",
          checkOut: "2026-10-10",
          adults: 2,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );

      expect(res.body).toHaveProperty(
        "requestId",
      );
    });

    it("returns 400 when check-in and check-out are the same date", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-10",
          adults: 2,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );
    });

    it("returns 400 for an invalid calendar date", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-02-31",
          checkOut: "2026-03-02",
          adults: 2,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );
    });

    it("returns 400 for zero adults", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 0,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );
    });

    it("returns 400 for more than the supported maximum adults", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 7,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );
    });

    it("returns 400 for fractional adults", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 2.5,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );
    });

    it("does not treat checkout date as an overnight stay", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-12-29",
          checkOut: "2026-12-30",
          adults: 2,
        });

      expect(res.status).toBe(200);

      expect(res.body.available).toBe(true);

      expect(
        res.body.rooms.length,
      ).toBeGreaterThan(0);
    });

    it("returns unavailable when the stay includes the fully booked date", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-12-30",
          checkOut: "2027-01-01",
          adults: 2,
        });

      expect(res.status).toBe(200);

      expect(res.body.available).toBe(false);

      expect(res.body.rooms).toEqual([]);

      expect(res.body.message).toBeTruthy();
    });
  });

  // =====================================================
  // 3. CHAT INPUT VALIDATION
  //
  // These tests should never reach the LLM.
  // =====================================================

  describe("POST /api/chat — input validation", () => {
    it("rejects an empty message", async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({
          message: "",
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );

      expect(res.body).toHaveProperty(
        "requestId",
      );
    });

    it("rejects a whitespace-only message", async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({
          message: "     ",
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );

      expect(res.body).toHaveProperty(
        "requestId",
      );
    });

    it("rejects a missing message", async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({});

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );
    });

    it("rejects a non-string message", async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({
          message: 12345,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );
    });

    it("returns a clarification response for an unresolved reference", async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({
          message: "Is it included?",
        });

      expect(res.status).toBe(200);
      expect(res.body.message.content).toMatch(/clarif/i);
      expect(res.body.metadata.grounded).toBe(false);
      expect(res.body.metadata.fallback).toBe(
        "clarification_requested",
      );
    });

    it("rejects an invalid conversationId", async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({
          message: "What time is check-in?",
          conversationId: 12345,
        });

      expect(res.status).toBe(400);

      expect(res.body).toHaveProperty(
        "error",
      );

      expect(res.body).toHaveProperty(
        "requestId",
      );
    });
  });

  // =====================================================
  // 4. CHAT — LLM-BACKED BEHAVIOR
  //
  // These tests require at least one configured
  // LLM provider.
  //
  // We test the API contract and system guarantees,
  // NOT exact LLM wording.
  // =====================================================

  const hasLLMCredentials = Boolean(
    (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith("test-stub")) ||
      (process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.startsWith("test-stub")),
  );

  const describeIfLLM =
    hasLLMCredentials
      ? describe
      : describe.skip;

  describeIfLLM(
    "POST /api/chat — LLM-backed responses",
    () => {
      it(
        "returns a grounded response for a supported FAQ",
        async () => {
          const res = await request(app)
            .post("/api/chat")
            .send({
              message:
                "What time is check-in?",
            });

          expect(res.status).toBe(200);

          expect(res.body).toHaveProperty(
            "conversationId",
          );

          expect(
            typeof res.body.conversationId,
          ).toBe("string");

          expect(res.body).toHaveProperty(
            "message",
          );

          expect(
            res.body.message.role,
          ).toBe("assistant");

          expect(
            typeof res.body.message.content,
          ).toBe("string");

          expect(
            res.body.message.content.length,
          ).toBeGreaterThan(0);

          expect(res.body).toHaveProperty(
            "metadata",
          );

          expect(
            res.body.metadata.grounded,
          ).toBe(true);

          expect(
            res.body.metadata,
          ).toHaveProperty("requestId");
        },
        15000,
      );

      it(
        "returns a safe ungrounded response when no supporting evidence exists",
        async () => {
          const res = await request(app)
            .post("/api/chat")
            .send({
              message:
                "Does the hotel have a helicopter landing pad?",
            });

          expect(res.status).toBe(200);

          expect(res.body.message).toBeTruthy();

          expect(
            res.body.message.role,
          ).toBe("assistant");

          expect(
            res.body.message.content,
          ).toBeTruthy();

          expect(res.body).toHaveProperty(
            "metadata",
          );

          expect(
            res.body.metadata.grounded,
          ).toBe(false);
        },
        15000,
      );

      it(
        "routes an availability question through checkAvailability",
        async () => {
          const res = await request(app)
            .post("/api/chat")
            .send({
              message:
                "Do you have a room available from 2026-10-10 to 2026-10-12 for 2 adults?",
            });

          expect(res.status).toBe(200);

          expect(
            res.body.message.role,
          ).toBe("assistant");

          expect(
            res.body.message.content,
          ).toBeTruthy();

          expect(res.body).toHaveProperty(
            "metadata",
          );

          expect(
            res.body.metadata.grounded,
          ).toBe(true);

          expect(
            res.body.metadata.toolUsed,
          ).toBe("checkAvailability");

          expect(
            res.body.metadata.availabilityData,
          ).toBeTruthy();
        },
        15000,
      );

      it(
        "accepts conversation history for a follow-up question",
        async () => {
          const res = await request(app)
            .post("/api/chat")
            .send({
              message:
                "What about the Executive Suite?",
              history: [
                {
                  role: "user",
                  content:
                    "Which room can accommodate 3 adults?",
                },
                {
                  role: "assistant",
                  content:
                    "The Executive Suite can accommodate up to 3 adults.",
                },
              ],
            });

          expect(res.status).toBe(200);

          expect(res.body.message).toBeTruthy();

          expect(
            res.body.message.role,
          ).toBe("assistant");

          expect(
            res.body.message.content,
          ).toBeTruthy();

          expect(res.body.metadata).toBeTruthy();
        },
        15000,
      );

      it(
        "returns a requestId for tracing an LLM request",
        async () => {
          const res = await request(app)
            .post("/api/chat")
            .send({
              message:
                "What is the Wi-Fi policy?",
            });

          expect(res.status).toBe(200);

          expect(
            typeof res.body.metadata
              .requestId,
          ).toBe("string");

          expect(
            res.body.metadata.requestId
              .length,
          ).toBeGreaterThan(0);
        },
        15000,
      );
    },
  );
});