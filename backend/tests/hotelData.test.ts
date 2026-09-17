import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { loadHotelData, getHotelDataOrThrow } from "../src/services/hotelKnowledge.js";

describe("Hotel Data API & Consistency", () => {
  let app: Express;

  beforeAll(() => {
    loadHotelData();
    app = createApp();
  });

  // =====================================================
  // 1. /api/hotel endpoint
  // =====================================================

  describe("GET /api/hotel", () => {
    it("returns 200 with hotel data", async () => {
      const res = await request(app).get("/api/hotel");

      expect(res.status).toBe(200);

      expect(res.body).toHaveProperty("property");
      expect(res.body).toHaveProperty("rooms");
      expect(res.body).toHaveProperty("amenities");
      expect(res.body).toHaveProperty("services");
      expect(res.body).toHaveProperty("policies");
      expect(res.body).toHaveProperty("faqs");
    });

    it("returns property with expected fields", async () => {
      const res = await request(app).get("/api/hotel");

      const prop = res.body.property;

      expect(prop).toHaveProperty("name");
      expect(prop).toHaveProperty("checkInTime");
      expect(prop).toHaveProperty("checkOutTime");
      expect(prop).toHaveProperty("currency");
      expect(prop).toHaveProperty("address");
      expect(prop).toHaveProperty("contact");
      expect(prop).toHaveProperty("starRating");
      expect(prop).toHaveProperty("totalRooms");
      expect(prop).toHaveProperty("paymentMethods");
    });

    it("returns rooms with image and badge fields", async () => {
      const res = await request(app).get("/api/hotel");

      for (const room of res.body.rooms) {
        expect(room.id).toBeTruthy();
        expect(room.name).toBeTruthy();
        expect(room).toHaveProperty("pricePerNight");
        expect(room).toHaveProperty("breakfastIncluded");
      }

      const execSuite = res.body.rooms.find(
        (r: { id: string }) => r.id === "exec",
      );

      expect(execSuite).toBeTruthy();
      expect(execSuite.badge).toBe("Most Popular");
      expect(execSuite.image).toBeTruthy();
    });

    it("returns services array with concierge and other services", async () => {
      const res = await request(app).get("/api/hotel");

      expect(Array.isArray(res.body.services)).toBe(true);
      expect(res.body.services.length).toBeGreaterThan(0);

      const serviceNames = res.body.services.map(
        (s: { name: string }) => s.name,
      );

      expect(serviceNames).toContain("Concierge");
      expect(serviceNames).toContain("24-Hour Front Desk");
    });
  });

  // =====================================================
  // 2. Data consistency: hotel.json vs rooms
  // =====================================================

  describe("hotel.json data consistency", () => {
    it("Executive Suite keywords include 'most popular'", () => {
      const hotel = getHotelDataOrThrow();

      const execSuite = hotel.rooms.find((r) => r.id === "exec");

      expect(execSuite).toBeDefined();

      const allKeywords = [
        ...execSuite!.keywords,
        ...(execSuite!.features ?? []),
        execSuite!.name,
      ].join(" ").toLowerCase();

      expect(allKeywords).toContain("most popular");
    });

    it("every room has an image path", () => {
      const hotel = getHotelDataOrThrow();

      for (const room of hotel.rooms) {
        expect(room.image).toBeTruthy();
      }
    });

    it("every room has a starRating on the property", () => {
      const hotel = getHotelDataOrThrow();

      expect(hotel.property.starRating).toBeGreaterThan(0);
    });

    it("property has payment methods and incidentals hold", () => {
      const hotel = getHotelDataOrThrow();

      expect(hotel.property.paymentMethods).toBeDefined();
      expect(hotel.property.paymentMethods!.length).toBeGreaterThan(0);
      expect(hotel.property.incidentalsHold).toBeDefined();
    });

    it("services array contains at least 4 guest services", () => {
      const hotel = getHotelDataOrThrow();

      expect(hotel.services).toBeDefined();
      expect(hotel.services!.length).toBeGreaterThanOrEqual(4);
    });

    it("dining amenity includes lunch and dinner hours", () => {
      const hotel = getHotelDataOrThrow();

      const dining = hotel.amenities.find((a) => a.id === "dining");

      expect(dining).toBeDefined();

      const details = dining!.details as Record<string, unknown>;

      expect(details.lunchStart).toBeTruthy();
      expect(details.lunchEnd).toBeTruthy();
      expect(details.dinnerStart).toBeTruthy();
      expect(details.dinnerEnd).toBeTruthy();
    });

    it("policies include payment and deposit information", () => {
      const hotel = getHotelDataOrThrow();

      const paymentPolicy = hotel.policies.find(
        (p) => p.id === "payment_deposit",
      );

      expect(paymentPolicy).toBeDefined();
      expect(paymentPolicy!.policy).toMatch(/hold|deposit/i);
    });

    it("faqs cover spa and dining hours topics", () => {
      const hotel = getHotelDataOrThrow();

      const faqIds = hotel.faqs.map((f) => f.id);

      expect(faqIds).toContain("faq_spa");
      expect(faqIds).toContain("faq_dining_hours");
      expect(faqIds).toContain("faq_payment");
      expect(faqIds).toContain("faq_accessibility");
      expect(faqIds).toContain("faq_airport");
      expect(faqIds).toContain("faq_age");
      expect(faqIds).toContain("faq_children");
    });

    it("pet policy correctly states pets are allowed", () => {
      const hotel = getHotelDataOrThrow();

      const petPolicy = hotel.policies.find((p) => p.id === "pets");

      expect(petPolicy).toBeDefined();
      const rules = petPolicy!.rules as Record<string, unknown>;

      expect(rules.allowed).toBe(true);
    });

    it("property location is consistent (Coastal Bay, not Goa)", () => {
      const hotel = getHotelDataOrThrow();

      expect(hotel.property.address.city).toBe("Coastal Bay");
      expect(hotel.property.address.country).toBe("US");
    });
  });

  // =====================================================
  // 3. Availability still works with updated data
  // =====================================================

  describe("availability with new data structure", () => {
    it("returns rooms with image and badge fields", async () => {
      const res = await request(app)
        .post("/api/availability")
        .send({
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          adults: 2,
        });

      expect(res.status).toBe(200);

      for (const room of res.body.rooms) {
        expect(room).toHaveProperty("id");
        expect(room).toHaveProperty("name");
        expect(room).toHaveProperty("pricePerNight");
        expect(room).toHaveProperty("availableRooms");
      }
    });
  });
});
