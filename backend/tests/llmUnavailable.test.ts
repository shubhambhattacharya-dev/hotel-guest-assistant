import {
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * LLM-unavailable behavior.
 *
 * The mock removes every provider for this test file, so these
 * tests pin the contract the assignment cares about: with no LLM
 * configured, deterministic features still work and every
 * AI-backed question fails HONESTLY (LlmUnavailableError / HTTP
 * 503) — never a fabricated or evidence-dump answer.
 */

vi.mock("../src/services/llmClient.js", () => ({
  LLM_CONFIG: {
    gemini: { model: "test-gemini", apiKey: undefined },
    groq: { model: "test-groq", apiKey: undefined },
    timeoutMs: 1_000,
    maxHistoryMessages: 8,
  },
  geminiClient: null,
  groqClient: null,
  getAvailableProviders: () => [],
  checkLLMHealth: async () => false,
}));

import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { loadHotelData } from "../src/services/hotelKnowledge.js";
import {
  AgentOrchestrator,
  LlmUnavailableError,
} from "../src/services/agentOrchestrator.js";

describe("LLM unavailable — orchestrator", () => {
  beforeAll(() => {
    loadHotelData();
  });

  it(
    "throws LlmUnavailableError for an AI-backed knowledge question",
    async () => {
      await expect(
        AgentOrchestrator.processMessage(
          "What time is check-in?",
          [],
          "test_req_1",
        ),
      ).rejects.toBeInstanceOf(LlmUnavailableError);
    },
  );

  it(
    "throws LlmUnavailableError for a dated availability question",
    async () => {
      await expect(
        AgentOrchestrator.processMessage(
          "Do you have rooms available from 2026-10-10 to 2026-10-12 for 2 adults?",
          [],
          "test_req_2",
        ),
      ).rejects.toMatchObject({
        code: "llm_not_configured",
      });
    },
  );

  it(
    "still answers pure small talk deterministically without a provider",
    async () => {
      const result =
        await AgentOrchestrator.processMessage(
          "hello",
          [],
          "test_req_3",
        );

      expect(result.content).toMatch(/welcome|hello/i);

      expect(result.metadata.fallback).toBe(
        "small_talk_scripted",
      );
    },
  );

  it(
    "still requests the availability form without a provider",
    async () => {
      const result =
        await AgentOrchestrator.processMessage(
          "Do you have any rooms free?",
          [],
          "test_req_4",
        );

      expect(
        result.metadata.requiresAvailabilityForm,
      ).toBe(true);
    },
  );

  it(
    "never leaks raw evidence as a fake answer",
    async () => {
      try {
        await AgentOrchestrator.processMessage(
          "What time is check-in?",
          [],
          "test_req_5",
        );
        expect.unreachable(
          "processMessage should have thrown",
        );
      } catch (error) {
        expect(error).toBeInstanceOf(LlmUnavailableError);

        if (error instanceof LlmUnavailableError) {
          expect(error.message).toMatch(
            /no LLM provider is configured/i,
          );

          expect(error.message).not.toMatch(
            /verified hotel information/i,
          );
        }
      }
    },
  );
});

describe("LLM unavailable — API contract", () => {
  let app: Express;

  beforeAll(() => {
    loadHotelData();
    app = createApp();
  });

  it(
    "returns 503 with a structured error for an AI-backed question",
    async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({ message: "What time is check-in?" });

      expect(res.status).toBe(503);

      expect(res.body).toMatchObject({
        code: "llm_not_configured",
      });

      expect(res.body.error).toBeTruthy();

      expect(res.body.requestId).toBeTruthy();

      // The response must NOT masquerade as a successful
      // assistant answer.
      expect(res.body.message).toBeUndefined();
    },
  );

  it(
    "still validates input before the provider check",
    async () => {
      const res = await request(app)
        .post("/api/chat")
        .send({ message: "" });

      expect(res.status).toBe(400);
    },
  );
});
