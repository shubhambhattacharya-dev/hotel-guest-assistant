/**
 * Mocked-LLM integration tests
 *
 * Uses vi.mock at module scope (hoisted by Vitest) to replace
 * AgentOrchestrator.processMessage with a controllable spy.
 * All 5 tests run in CI without any live API keys.
 */
import {
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { loadHotelData } from "../src/services/hotelKnowledge.js";

// vi.mock is hoisted to the top of the compiled output by Vitest,
// so it MUST be at the module top level (not inside describe/beforeEach).
vi.mock("../src/services/agentOrchestrator.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/agentOrchestrator.js")>();
  return {
    ...mod,
    AgentOrchestrator: {
      ...mod.AgentOrchestrator,
      processMessage: vi.fn(),
    },
  };
});

// ─── Shared stub responses ────────────────────────────────────────────────

function makeResponse(overrides: Partial<{
  requestId: string;
  content: string;
  grounded: boolean;
  toolUsed: string | null;
  availabilityData: unknown;
}> = {}) {
  return {
    role: "assistant" as const,
    content: overrides.content ?? "Mock answer.",
    metadata: {
      requestId: overrides.requestId ?? "mock-req",
      grounded: overrides.grounded ?? true,
      provider: "gemini",
      model: "gemini-mock",
      toolUsed: overrides.toolUsed ?? null,
      tokensIn: 200,
      tokensOut: 50,
      latencyMs: 100,
      retrieval: true,
      fallback: false,
      availabilityData: overrides.availabilityData ?? undefined,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("POST /api/chat — mocked-LLM responses", () => {
  let app: Express;

  beforeAll(() => {
    loadHotelData();
    app = createApp();
  });

  it("returns a grounded response for a supported FAQ (check-in time)", async () => {
    const { AgentOrchestrator } = await import("../src/services/agentOrchestrator.js");
    vi.mocked(AgentOrchestrator.processMessage).mockResolvedValueOnce(
      makeResponse({ content: "Check-in is from 3:00 PM.", grounded: true }),
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "What time is check-in?" });

    expect(res.status).toBe(200);
    expect(typeof res.body.conversationId).toBe("string");
    expect(res.body.conversationId.length).toBeGreaterThan(0);
    expect(res.body.message.role).toBe("assistant");
    expect(typeof res.body.message.content).toBe("string");
    expect(res.body.message.content.length).toBeGreaterThan(0);
    expect(res.body.metadata.grounded).toBe(true);
    expect(typeof res.body.metadata.requestId).toBe("string");
  });

  it("returns a safe ungrounded response when no supporting evidence exists", async () => {
    const { AgentOrchestrator } = await import("../src/services/agentOrchestrator.js");
    vi.mocked(AgentOrchestrator.processMessage).mockResolvedValueOnce(
      makeResponse({ content: "Sorry, I don't have verified information about that.", grounded: false }),
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Does the hotel have a helicopter landing pad?" });

    expect(res.status).toBe(200);
    expect(res.body.message.role).toBe("assistant");
    expect(res.body.message.content).toBeTruthy();
    expect(res.body.metadata.grounded).toBe(false);
  });

  it("routes an availability question through checkAvailability tool", async () => {
    const { AgentOrchestrator } = await import("../src/services/agentOrchestrator.js");
    vi.mocked(AgentOrchestrator.processMessage).mockResolvedValueOnce(
      makeResponse({
        content: "Great news! We have rooms available.",
        grounded: true,
        toolUsed: "checkAvailability",
        availabilityData: {
          available: true,
          checkIn: "2026-10-10",
          checkOut: "2026-10-12",
          nights: 2,
          adults: 2,
          rooms: [{ id: "deluxe", name: "Deluxe Room", maxOccupancy: 2, pricePerNight: 180, currency: "USD" }],
          message: "2 rooms available.",
        },
      }),
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Do you have a room available from 2026-10-10 to 2026-10-12 for 2 adults?" });

    expect(res.status).toBe(200);
    expect(res.body.message.role).toBe("assistant");
    expect(res.body.message.content).toBeTruthy();
    expect(res.body.metadata.grounded).toBe(true);
    expect(res.body.metadata.toolUsed).toBe("checkAvailability");
    expect(res.body.metadata.availabilityData).toBeTruthy();
  });

  it("accepts conversation history for a follow-up question", async () => {
    const { AgentOrchestrator } = await import("../src/services/agentOrchestrator.js");
    vi.mocked(AgentOrchestrator.processMessage).mockResolvedValueOnce(
      makeResponse({ content: "The Executive Suite can accommodate up to 3 guests.", grounded: true }),
    );

    const res = await request(app)
      .post("/api/chat")
      .send({
        message: "What about the Executive Suite?",
        history: [
          { role: "user", content: "Which room can accommodate 3 adults?" },
          { role: "assistant", content: "The Executive Suite can accommodate up to 3 adults." },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.message.role).toBe("assistant");
    expect(res.body.message.content).toBeTruthy();
    expect(res.body.metadata).toBeTruthy();
  });

  it("returns a requestId for tracing an LLM request", async () => {
    const { AgentOrchestrator } = await import("../src/services/agentOrchestrator.js");
    vi.mocked(AgentOrchestrator.processMessage).mockResolvedValueOnce(
      makeResponse({ requestId: "trace-abc-123", content: "Wi-Fi is complimentary for all guests." }),
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "What is the Wi-Fi policy?" });

    expect(res.status).toBe(200);
    expect(typeof res.body.metadata.requestId).toBe("string");
    expect(res.body.metadata.requestId.length).toBeGreaterThan(0);
  });
});
