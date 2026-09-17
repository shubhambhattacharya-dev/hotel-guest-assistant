import { Type } from "@google/genai";
import { z } from "zod";

import logger from "../core/logger.js";
import { getHotelDataOrThrow } from "./hotelKnowledge.js";
import {
  AvailabilityService,
  defaultAvailabilityProvider,
} from "./availabilityService.js";
import { LLM_CONFIG, geminiClient, groqClient } from "./llmClient.js";

import type { HotelData, Room } from "../types/hotel.js";
import type { AvailabilityResult } from "./availabilityService.js";

/**
 * Conversation message accepted from the API.
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Final result returned to the chat route.
 */
export interface OrchestrationResult {
  role: "assistant";
  content: string;

  metadata: {
    grounded: boolean;
    toolUsed?: string | null;
    availabilityData?: AvailabilityResult | null;
    requiresAvailabilityForm?: boolean;
    availabilityFormPrefill?: { adults?: number };
    fallback?: string | null;
    provider?: "gemini" | "groq" | null;
    model?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    toolLatencyMs?: number | null;
    retrieval?: {
      latencyMs: number;
      topScore: number;
      evidence: string | null;
    } | null;
  };
}

/**
 * Thrown when the assistant cannot reach any LLM provider —
 * either none is configured (missing API keys) or every
 * configured provider failed.
 *
 * The chat route maps this to HTTP 503 so the frontend shows an
 * honest failure state instead of a fabricated answer.
 */
export class LlmUnavailableError extends Error {
  public readonly code:
    | "llm_not_configured"
    | "all_llm_providers_failed";

  public constructor(
    message: string,
    code: "llm_not_configured" | "all_llm_providers_failed",
  ) {
    super(message);
    this.name = "LlmUnavailableError";
    this.code = code;
  }
}

/**
 * ---------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------
 *
 * Provider clients and models come from llmClient.ts — the
 * single place that reads provider env vars and builds SDK
 * clients (shared with the /ready health endpoint).
 */

const GEMINI_MODEL = LLM_CONFIG.gemini.model;

const GROQ_MODEL = LLM_CONFIG.groq.model;

const MAX_HISTORY_MESSAGES = 8;
const MAX_EVIDENCE_ITEMS = 4;
const EVIDENCE_THRESHOLD = 0.25;

const GEMINI_MAX_RETRIES = 1;
const GROQ_MAX_RETRIES = 1;
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 1024);

/**
 * ---------------------------------------------------------
 * Availability form trigger
 * ---------------------------------------------------------
 *
 * Guests frequently ask for availability without naming
 * dates ("are any rooms free?"). The models are never
 * allowed to invent dates, so these detectors decide —
 * deterministically, before any provider call — whether
 * the request can run or the client should collect the
 * missing details through the availability form.
 *
 * Mirrored in the frontend (app/page.tsx) so common cases
 * are intercepted instantly without a network round trip.
 */

/** Amenity/policy questions that merely contain "available" or "rooms". */
const AMENITY_TOPIC_RE =
  /\b(wi-?fi|internet|parking|valet|breakfast|pool|gym|fitness|restaurant|dining|bistro|bar|room service|pets?|dog|cat|smoking|cancellation|cancel|refund|polic(?:y|ies)|amenit\w*|spa|laundry|shuttle|early check-?in|late check-?out)\b/i;

/** Any date a model could resolve: ISO, "Oct 10", "10 Oct", "10/12", or relative terms. */
const MENTIONED_DATES_RE =
  /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:today|tonight|tomorrow|this week|next week|this weekend|next weekend|this month|next month|mon(?:day)?|tues(?:day)?|wed(?:nesday|s)?|thur(?:s|sday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;

function hasAvailabilityIntent(
  message: string,
): boolean {
  if (AMENITY_TOPIC_RE.test(message)) {
    return false;
  }

  return (
    /\b(?:rooms?|suites?|stay)\b[^.?!]{0,40}\b(?:available|availability|vacant|vacancies|free|open)\b/i.test(message) ||
    /\b(?:available|availability|vacant|vacancies|free|open)\b[^.?!]{0,40}\b(?:rooms?|suites?|stay)\b/i.test(message) ||
    /\b(?:any|got|have)\s+(?:any\s+)?(?:rooms?|suites?)\b/i.test(message) ||
    /\b(?:rooms?|suites?)\s+(?:free|open)\b/i.test(message) ||
    /\b(?:book|reserve)\b[^.?!]{0,40}\b(?:rooms?|suites?|stay)\b/i.test(message) ||
    /\b(?:rooms?|suites?|stay)\b[^.?!]{0,40}\b(?:book|reserve)\b/i.test(message) ||
    /\b(?:availability|vacancies|vacancy)\b/i.test(message)
  );
}

/**
 * True when the message asks about room availability or
 * booking but contains no date the tool could use.
 */
function isUndatedAvailabilityRequest(
  message: string,
): boolean {
  return hasAvailabilityIntent(message) && !MENTIONED_DATES_RE.test(message);
}

/**
 * Whole-message small talk (greetings, thanks, acknowledgements).
 *
 * These are not questions: they must never reach the evidence
 * gate, which would answer "hi" with a refusal. The ENTIRE
 * message must be small talk — a greeting wrapped around a real
 * request ("hi, got rooms free?") flows through normally.
 */
const SMALL_TALK_RE =
  /^\s*(?:hi+|hey+|hello|yo|hiya|howdy|good\s*(?:morning|afternoon|evening|day)|(?:many\s+)?thanks?|thank\s*you|thx|ty|bye|goodbye|see\s*ya|ok(?:ay)?|cool|great|nice|awesome|perfect|alright|got\s*it)\s*[.!?]*\s*$/i;

export function isSmallTalk(message: string): boolean {
  return SMALL_TALK_RE.test(message);
}

const AMBIGUOUS_REFERENCE_RE =
  /\b(?:it|that|this|those|them)\b/i;

const CLARIFICATION_CUE_RE =
  /\b(?:included?|include|cost|price|prices|available|availability|open|free|have|has|does|is|are|what|how|when|where|which|details?|features?)\b/i;

const WELCOME_PATTERN = /Hi there|AI hotel assistant|Ask me anything|perfect stay/i;

function hasConversationContext(
  history: ConversationMessage[],
): boolean {
  return history.some(
    (item) =>
      item.content.trim().length > 0 &&
      !WELCOME_PATTERN.test(item.content),
  );
}

export function isAmbiguousReference(
  message: string,
  conversationHistory: ConversationMessage[] = [],
): boolean {
  const trimmed = message.trim();

  return (
    !hasConversationContext(conversationHistory) &&
    AMBIGUOUS_REFERENCE_RE.test(trimmed) &&
    CLARIFICATION_CUE_RE.test(trimmed)
  );
}

const PROMPT_INJECTION_RE =
  /\b(?:ignore\s+(?:all\s+)?(?:previous\s+|your\s+|the\s+)?(?:instructions|rules|prompt|hotel information|hotel info)|reveal\s+(?:your\s+)?(?:system\s+)?prompt|disregard\s+(?:all\s+)?(?:previous\s+)?(?:your\s+|the\s+)?(?:instructions|hotel information|hotel info))\b/i;

export function isPromptInjectionAttempt(
  message: string,
): boolean {
  return PROMPT_INJECTION_RE.test(message.trim());
}

/**
 * ---------------------------------------------------------
 * Numeric claim verification (hallucination guard)
 * ---------------------------------------------------------
 *
 * The evidence gate proves the model SAW relevant evidence; it
 * does not prove the model REPEATED only that evidence. Models
 * still invent figures — e.g. restaurant hours that exist
 * nowhere in the knowledge base ("lunch is served 12–3 PM").
 *
 * This guard is deterministic: extract every figure-shaped
 * claim (times, prices, measurements, capacities) from a draft
 * answer and verify each against the authoritative source text.
 * A claim passes if it appears in the source (normalized) or if
 * every number it contains appears in the source. Unsupported
 * claims trigger one corrective rewrite, then a refusal.
 */
const NUMERIC_CLAIM_PATTERNS: RegExp[] = [
  // $20, $ 35, $250 cleaning fee
  /\$\s?\d+(?:\.\d+)?/g,
  // 180 USD, 310 dollars
  /\b\d+(?:\.\d+)?\s*(?:usd|inr|eur|gbp|dollars?)\b/gi,
  // USD 180, $ 35
  /\b(?:usd|inr|eur|gbp|dollars?)\s?\d+(?:\.\d+)?/gi,
  // 7:00 AM, 10:00 p.m., 3 pm
  /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi,
  // 24h clock times: 07:00, 22:30
  /\b\d{1,2}:\d{2}\b/g,
  // measurements: 300 Mbps, 25 lbs, 100%, 15 meters, 48 hours, 2 guests
  // (no trailing \b: units like "%" are non-word chars and would break it)
  /\b\d+(?:\.\d+)?\s*(?:mbps|gb|tb|lbs?|kg|%|percent|meters?|metres?|sqm|sq\s?m|km|feet|hours?|hrs?|minutes?|mins?|guests?|adults?|people|persons?|rooms?|bedrooms?)/gi,
  // 24/7 room service
  /\b\d+\s*\/\s*\d+\b/g,
];

export function extractNumericClaims(text: string): string[] {
  const claims = new Set<string>();
  for (const pattern of NUMERIC_CLAIM_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const claim of matches) claims.add(claim.trim());
    }
  }
  return Array.from(claims);
}

function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\$\s+/g, "$")
    .replace(/\s+%/g, "%")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNumbers(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

function claimIsSupported(claim: string, source: string): boolean {
  const normalizedClaim = normalizeClaimText(claim);
  const normalizedSource = normalizeClaimText(source);

  // Strong pass: the exact claim figure appears in the source.
  if (normalizedSource.includes(normalizedClaim)) return true;

  // Weak pass: every number of the claim appears in the source
  // (covers benign reformatting such as "$20 / guest / day").
  const claimNumbers = extractNumbers(normalizedClaim);
  if (claimNumbers.length === 0) return true;
  const sourceNumbers = new Set(extractNumbers(normalizedSource));
  return claimNumbers.every((n) => sourceNumbers.has(n));
}

/**
 * Returns the numeric claims in `text` that cannot be traced to
 * `authoritativeSource` (retrieved evidence, tool results, or the
 * assistant's own previously verified answer).
 */
export function findUnsupportedNumericClaims(
  text: string,
  authoritativeSource: string,
): string[] {
  return extractNumericClaims(text).filter(
    (claim) => !claimIsSupported(claim, authoritativeSource),
  );
}

/**
 * ---------------------------------------------------------
 * Agent decision contract (provider-agnostic)
 * ---------------------------------------------------------
 *
 * Unified decision contract using a Zod discriminated union.
 * Both providers validate their decisions through this schema.
 */
export const AgentDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("answer"),
    text: z.string(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal("check_availability"),
    args: z.unknown(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal("clarify"),
    text: z.string(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal("fallback"),
    reason: z.string(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    model: z.string().optional(),
  }),
]);

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

const AVAILABILITY_TOOL_DESCRIPTION =
  "Check hotel room availability for specific check-in and check-out dates and number of adults. Use this when the guest asks about availability, available rooms, vacancy, or booking availability.";

/**
 * OpenAI-compatible tool declaration for Groq.
 * Mirrors the Gemini function declaration below.
 */
const groqAvailabilityTool = {
  type: "function" as const,

  function: {
    name: "checkAvailability",

    description: AVAILABILITY_TOOL_DESCRIPTION,

    parameters: {
      type: "object" as const,

      properties: {
        checkIn: {
          type: "string" as const,
          description:
            "Check-in date in YYYY-MM-DD format.",
        },

        checkOut: {
          type: "string" as const,
          description:
            "Check-out date in YYYY-MM-DD format.",
        },

        adults: {
          type: "number" as const,
          description:
            "Number of adult guests.",
        },

        roomType: {
          type: "string" as const,
          description:
            "Optional requested room type, such as Deluxe Room, Executive Suite, or Family Suite.",
        },
      },

      required: [
        "checkIn",
        "checkOut",
        "adults",
      ],
    },
  },
};

/**
 * Schema-level validation of Groq tool arguments.
 * Value-level rules (real dates, ordering, bounds) are
 * enforced later by AvailabilityService.
 */
const GroqToolArgsSchema = z.object({
  checkIn: z.string(),

  checkOut: z.string(),

  adults: z.number(),

  roomType: z.string().optional(),
});

/**
 * ---------------------------------------------------------
 * Availability tool
 * ---------------------------------------------------------
 *
 * The primary provider decides WHEN this tool is required.
 *
 * The backend still:
 *
 * 1. validates arguments
 * 2. executes the deterministic service
 * 3. owns the actual availability result
 *
 * The LLM never calculates availability.
 */

const availabilityTool = {
  functionDeclarations: [
    {
      name: "checkAvailability",

      description: AVAILABILITY_TOOL_DESCRIPTION,

      parameters: {
        type: Type.OBJECT,

        properties: {
          checkIn: {
            type: Type.STRING,
            description:
              "Check-in date in YYYY-MM-DD format.",
          },

          checkOut: {
            type: Type.STRING,
            description:
              "Check-out date in YYYY-MM-DD format.",
          },

          adults: {
            type: Type.NUMBER,
            description:
              "Number of adult guests.",
          },

          roomType: {
            type: Type.STRING,
            description:
              "Optional requested room type, such as Deluxe Room, Executive Suite, or Family Suite.",
          },
        },

        required: [
          "checkIn",
          "checkOut",
          "adults",
        ],
      },
    },
  ],
};

/**
 * ---------------------------------------------------------
 * Retry helper
 * ---------------------------------------------------------
 */

async function withGeminiRetry<T>(
  operation: () => Promise<T>,
  requestId: string,
  label: string,
): Promise<T> {
  let lastError: unknown;

  for (
    let attempt = 0;
    attempt <= GEMINI_MAX_RETRIES;
    attempt++
  ) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      const isLastAttempt =
        attempt === GEMINI_MAX_RETRIES;

      logger.warn(
        {
          requestId,
          label,
          attempt: attempt + 1,
          isLastAttempt,
          err: error,
        },
        isLastAttempt
          ? "Gemini request failed"
          : "Gemini request failed; retrying",
      );

      if (!isLastAttempt) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500),
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Gemini request failed");
}

async function withGroqRetry<T>(
  operation: () => Promise<T>,
  requestId: string,
  label: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      const isLastAttempt = attempt === GROQ_MAX_RETRIES;

      logger.warn(
        {
          requestId,
          label,
          attempt: attempt + 1,
          isLastAttempt,
          err: error,
        },
        isLastAttempt
          ? "Groq request failed"
          : "Groq request failed; retrying",
      );

      if (!isLastAttempt) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Groq request failed");
}

/**
 * ---------------------------------------------------------
 * Main orchestrator
 * ---------------------------------------------------------
 */

export class AgentOrchestrator {
  public static async processMessage(
    userMessage: string,
    conversationHistory: ConversationMessage[] = [],
    requestId: string,
  ): Promise<OrchestrationResult> {
    const hotelData = getHotelDataOrThrow();

    const message = userMessage.trim();

    if (!message) {
      return {
        role: "assistant",
        content:
          "Please tell me how I can help with your stay.",
        metadata: {
          grounded: false,
          fallback: "empty_message",
          provider: null,
        },
      };
    }

    /**
     * -----------------------------------------------------
     * Small talk
     * -----------------------------------------------------
     *
     * Greetings and acknowledgements are scripted deterministically.
     * They never reach the evidence gate, which would otherwise
     * answer "hi" with a refusal.
     */
    if (isSmallTalk(message)) {
      return {
        role: "assistant",
        content:
          `Hello, and welcome to ${hotelData.property.name}! 👋 ` +
          "I can help with rooms, amenities, dining, and policies — or share your dates " +
          "and party size and I'll check availability for you.",
        metadata: {
          grounded: false,
          fallback: "small_talk_scripted",
          provider: null,
        },
      };
    }

    if (
      isAmbiguousReference(
        message,
        conversationHistory,
      )
    ) {
      return {
        role: "assistant",
        content:
          "Could you clarify what you mean by “it” or “that”? For example, you can ask whether breakfast, Wi-Fi, parking, or a specific room feature is included.",
        metadata: {
          grounded: false,
          fallback: "clarification_requested",
          provider: null,
        },
      };
    }

    if (isPromptInjectionAttempt(message)) {
      return {
        role: "assistant",
        content:
          "I can help with hotel questions, but I cannot reveal internal instructions or follow requests to override my hotel guidance. What would you like to know about your stay?",
        metadata: {
          grounded: false,
          fallback: "prompt_injection_deflected",
          provider: null,
        },
      };
    }

    /**
     * -----------------------------------------------------
     * Availability without dates
     * -----------------------------------------------------
     *
     * Ask for the missing details and signal the client to
     * render the availability form (prefilled with any guest
     * count already mentioned) instead of spending a provider
     * call that must refuse to guess dates.
     */
    if (isUndatedAvailabilityRequest(message)) {
      const adults =
        this.extractRequestedCapacity(message);

      logger.info(
        { requestId, adults },
        "Availability requested without dates; requesting availability form",
      );

      return {
        role: "assistant",
        content:
          "I'd be happy to check availability for you. Could you share your check-in and check-out dates and the number of guests? " +
          "You can also enter them in the availability form below.",
        metadata: {
          grounded: false,
          fallback:
            "availability_details_requested",
          requiresAvailabilityForm: true,
          availabilityFormPrefill: adults
            ? { adults }
            : undefined,
          provider: null,
        },
      };
    }

    /**
     * -----------------------------------------------------
     * Provider availability — fail fast, fail honestly
     * -----------------------------------------------------
     *
     * The deterministic features above (greeting, availability
     * form request) work without any provider. Everything below
     * this point requires an LLM. If none is configured for this
     * process, surface an error instead of fabricating an answer
     * from retrieved evidence.
     *
     * NOTE: clients are built once at module load from the
     * environment, so adding or removing API keys requires a
     * backend restart to take effect.
     */
    if (!geminiClient && !groqClient) {
      logger.error(
        { requestId },
        "No LLM provider is configured; set GEMINI_API_KEY or GROQ_API_KEY and restart the backend",
      );

      throw new LlmUnavailableError(
        "The AI concierge is not available because no LLM provider is configured on this server.",
        "llm_not_configured",
      );
    }

    /**
     * Keep conversation context bounded.
     */
    const recentHistory =
      conversationHistory
        .filter(
          (item) =>
            (item.role === "user" ||
              item.role === "assistant") &&
            item.content.trim().length > 0,
        )
        .slice(-MAX_HISTORY_MESSAGES);

    /**
     * -----------------------------------------------------
     * Deterministic retrieval
     * -----------------------------------------------------
     *
     * Guests ask short follow-ups ("cost?", "and breakfast?")
     * that only make sense against the previous turn. Retrieval
     * therefore anchors on the current message PLUS the last
     * user turn, so follow-up questions still retrieve the
     * evidence they refer to instead of failing the gate.
     */
    const lastUserTurn = [...recentHistory]
      .reverse()
      .find((item) => item.role === "user")?.content;

    const retrievalQuery =
      lastUserTurn && lastUserTurn !== message
        ? `${message} ${lastUserTurn}`
        : message;

    const retrievalStart = Date.now();
    const retrieval =
      this.retrieveKnowledge(
        retrievalQuery,
        hotelData,
      );
    const retrievalLatencyMs = Date.now() - retrievalStart;
    const retrievalMetadata = {
      latencyMs: retrievalLatencyMs,
      topScore: retrieval.score,
      evidence: retrieval.evidence.length > 0 ? "hotel_knowledge" : null,
    };

    const evidenceAvailable =
      retrieval.score >= EVIDENCE_THRESHOLD &&
      retrieval.evidence.length > 0;

    /**
     * Verification source for the numeric-claim guard.
     *
     * The model may legitimately restate figures from its own
     * previous answer (which was itself verified against
     * evidence or tool output), so the last assistant turn is
     * included alongside the retrieved evidence.
     */
    const lastAssistantTurn = [...recentHistory]
      .reverse()
      .find((item) => item.role === "assistant")?.content;

    const verificationSource = [
      ...retrieval.evidence,
      ...(lastAssistantTurn ? [lastAssistantTurn] : []),
    ].join("\n");

    /**
     * -----------------------------------------------------
     * Agent step: Groq primary, Gemini fallback
     * -----------------------------------------------------
     *
     * The primary provider decides whether the availability
     * tool is needed; the secondary provider receives the
     * same decision only if the primary fails.
     *
     * Grounding rules are identical for both providers:
     * answers must come from the retrieved evidence, and
     * tool arguments are validated by AvailabilityService
     * no matter which provider proposed them.
     */

    const agentProviders: Array<"groq" | "gemini"> = [];

    if (groqClient) {
      agentProviders.push("groq");
    }

    if (geminiClient) {
      agentProviders.push("gemini");
    }

    for (const provider of agentProviders) {
      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let lastModelUsed: string | null = provider === "groq" ? GROQ_MODEL : GEMINI_MODEL;

      try {
        const decision =
          provider === "groq"
            ? await this.decideWithGroq({
                message,
                recentHistory,
                hotelData,
                evidence: retrieval.evidence,
                evidenceAvailable,
                requestId,
              })
            : await this.runGeminiAgent({
                message,
                recentHistory,
                hotelData,
                evidence: retrieval.evidence,
                evidenceAvailable,
                requestId,
              });

        totalTokensIn += decision.tokensIn ?? 0;
        totalTokensOut += decision.tokensOut ?? 0;
        if (decision.model) lastModelUsed = decision.model;

        if (decision.type === "fallback") {
          logger.warn(
            { requestId, provider, reason: decision.reason },
            "Agent decided to fallback; trying next provider",
          );
          continue;
        }

        if (decision.type === "clarify") {
          return {
            role: "assistant",
            content: decision.text,
            metadata: {
              grounded: false,
              fallback: "clarification_requested",
              provider,
              model: lastModelUsed,
              tokensIn: totalTokensIn,
              tokensOut: totalTokensOut,
              retrieval: retrievalMetadata,
            },
          };
        }

        /**
         * -------------------------------------------------
         * Tool requested
         * -------------------------------------------------
         */

        if (decision.type === "check_availability") {
          logger.info(
            {
              requestId,
              provider,
              tool: "checkAvailability",
            },
            "Agent requested availability tool",
          );

          let availabilityResult: AvailabilityResult;
          let toolLatencyMs = 0;

          try {
            /**
             * IMPORTANT:
             *
             * Tool arguments are untrusted model output.
             * AvailabilityService validates them using Zod.
             */
            const toolStart = Date.now();
            availabilityResult =
              await defaultAvailabilityProvider.checkAvailability(
                decision.args,
              );
            toolLatencyMs = Date.now() - toolStart;
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : "Invalid availability request.";

            logger.warn(
              {
                requestId,
                provider,
                err: error,
              },
              "Availability tool rejected agent arguments",
            );

            return {
              role: "assistant",
              content:
                `I couldn't check availability because ${errorMessage} ` +
                "Please provide valid check-in, check-out, and guest information.",
              metadata: {
                grounded: false,
                toolUsed:
                  "checkAvailability",
                fallback:
                  "availability_validation_error",
                provider,
                model: lastModelUsed,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                toolLatencyMs,
                retrieval: retrievalMetadata,
              },
            };
          }

          /**
           * The tool result is authoritative.
           *
           * Either provider may verbalize it; neither is
           * allowed to modify the deterministic result.
           */
          try {
            const response =
              await this.generateAvailabilityResponse({
                hotelName:
                  hotelData.property.name,
                userMessage: message,
                conversationHistory:
                  recentHistory,
                availabilityResult,
                requestId,
              });

            totalTokensIn += response.tokensIn ?? 0;
            totalTokensOut += response.tokensOut ?? 0;
            if (response.model) lastModelUsed = response.model;

            /**
             * The verbalization must not alter any tool figure.
             * If it invents or changes numbers, fall back to a
             * deterministic rendering of the tool result — the
             * guest always gets correct data, with or without
             * the LLM's phrasing.
             */
            const unsupported =
              findUnsupportedNumericClaims(
                response.content,
                JSON.stringify(availabilityResult),
              );

            if (unsupported.length > 0) {
              logger.warn(
                {
                  requestId,
                  provider: response.provider,
                  unsupported,
                },
                "Availability verbalization altered tool figures; using deterministic fallback",
              );

              return {
                role: "assistant",
                content:
                  this.renderAvailabilityDeterministically(
                    availabilityResult,
                  ),
                metadata: {
                  grounded: true,
                  toolUsed: "checkAvailability",
                  availabilityData: availabilityResult,
                  fallback:
                    "availability_verbalization_replaced",
                  provider: null,
                  model: lastModelUsed,
                  tokensIn: totalTokensIn,
                  tokensOut: totalTokensOut,
                  toolLatencyMs,
                  retrieval: {
                    ...retrievalMetadata,
                    evidence: "tool.checkAvailability",
                  },
                },
              };
            }

            return {
              role: "assistant",
              content: response.content,
              metadata: {
                grounded: true,
                toolUsed:
                  "checkAvailability",
                availabilityData:
                  availabilityResult,
                provider:
                  response.provider,
                model: lastModelUsed,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                toolLatencyMs,
                retrieval: {
                  ...retrievalMetadata,
                  evidence: "tool.checkAvailability",
                },
              },
            };
          } catch (error: unknown) {
            logger.error(
              {
                requestId,
                err: error,
              },
              "Availability response generation failed",
            );

            return {
              role: "assistant",
              content:
                "I checked the availability service, but I couldn't generate the response right now. Please try again shortly.",
              metadata: {
                grounded: false,
                toolUsed:
                  "checkAvailability",
                availabilityData:
                  availabilityResult,
                fallback:
                  "availability_response_generation_failed",
                provider: null,
                model: lastModelUsed,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                toolLatencyMs,
                retrieval: retrievalMetadata,
              },
            };
          }
        }

        /**
         * -------------------------------------------------
         * Knowledge response
         * -------------------------------------------------
         *
         * The evidence gate is deterministic and identical
         * for every provider, so a gate failure returns
         * immediately instead of burning fallback quota.
         */

        if (!evidenceAvailable) {
          logger.info(
            {
              requestId,
              provider,
              score: retrieval.score,
            },
            "Evidence gate failed",
          );

          return {
            role: "assistant",
            content:
              "I'm sorry, I don't have enough verified hotel information to answer that question.",
            metadata: {
              grounded: false,
              fallback:
                "insufficient_evidence",
              provider,
              model: lastModelUsed,
              tokensIn: totalTokensIn,
              tokensOut: totalTokensOut,
              retrieval: retrievalMetadata,
            },
          };
        }

        if (decision.type !== "answer" || !decision.text) {
          throw new Error(
            `${provider} returned no usable text`,
          );
        }

        /**
         * -------------------------------------------------
         * Numeric claim verification
         * -------------------------------------------------
         *
         * Every figure in the draft must trace back to the
         * evidence, the tool result, or the assistant's own
         * previously verified answer. Invented figures get one
         * corrective rewrite; a second failure refuses safely.
         */
        let unsupportedClaims = findUnsupportedNumericClaims(
          decision.text,
          verificationSource,
        );

        let finalText = decision.text;

        if (unsupportedClaims.length > 0) {
          logger.warn(
            {
              requestId,
              provider,
              unsupportedClaims,
            },
            "Draft contained unsupported numeric claims; requesting correction",
          );

          const correctiveNote =
            `Your previous draft contained figures that do not exist in the verified evidence: ` +
            `${unsupportedClaims.join(", ")}. ` +
            `Rewrite your answer using ONLY figures that appear verbatim in the evidence. ` +
            `If a figure is not in the evidence, omit that detail entirely — never estimate.`;

          const corrected =
            provider === "groq"
              ? await this.decideWithGroq({
                  message,
                  recentHistory,
                  hotelData,
                  evidence: retrieval.evidence,
                  evidenceAvailable,
                  requestId,
                  correctiveNote,
                })
              : await this.runGeminiAgent({
                  message,
                  recentHistory,
                  hotelData,
                  evidence: retrieval.evidence,
                  evidenceAvailable,
                  requestId,
                  correctiveNote,
                });

          totalTokensIn += corrected.tokensIn ?? 0;
          totalTokensOut += corrected.tokensOut ?? 0;
          if (corrected.model) lastModelUsed = corrected.model;

          const correctedText =
            corrected.type === "answer" ? corrected.text : null;

          const stillUnsupported =
            correctedText
              ? findUnsupportedNumericClaims(
                  correctedText,
                  verificationSource,
                )
              : ["no corrected draft"];

          if (correctedText && stillUnsupported.length === 0) {
            finalText = correctedText;
          } else {
            logger.warn(
              {
                requestId,
                provider,
                stillUnsupported,
              },
              "Corrected draft still failed numeric verification; refusing",
            );

            return {
              role: "assistant",
              content:
                "I'm sorry, I don't have enough verified hotel information to answer that question.",
              metadata: {
                grounded: false,
                fallback: "numeric_claim_verification_failed",
                provider,
                model: lastModelUsed,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                retrieval: retrievalMetadata,
              },
            };
          }
        }

        return {
          role: "assistant",
          content: finalText,
          metadata: {
            grounded: true,
            toolUsed: null,
            provider,
            model: lastModelUsed,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            retrieval: retrievalMetadata,
          },
        };
      } catch (error: unknown) {
        logger.error(
          {
            requestId,
            provider,
            err: error,
          },
          "Agent provider failed; trying next provider",
        );
      }
    }

    /**
     * -----------------------------------------------------
     * All providers failed
     * -----------------------------------------------------
     *
     * Both providers threw. Surface an honest error to the
     * guest instead of fabricating an answer from evidence.
     */
    logger.error(
      { requestId },
      "All LLM providers failed",
    );

    throw new LlmUnavailableError(
      "The AI concierge is temporarily unavailable. Please try again in a moment.",
      "all_llm_providers_failed",
    );
  }

  /**
   * -------------------------------------------------------
   * Gemini agent call
   * -------------------------------------------------------
   */

  private static async runGeminiAgent({
    message,
    recentHistory,
    hotelData,
    evidence,
    evidenceAvailable,
    requestId,
    correctiveNote,
  }: {
    message: string;
    recentHistory: ConversationMessage[];
    hotelData: HotelData;
    evidence: string[];
    evidenceAvailable: boolean;
    requestId: string;
    correctiveNote?: string;
  }): Promise<AgentDecision> {
    if (!geminiClient) {
      throw new Error(
        "Gemini client is not configured",
      );
    }

    // Imported bindings do not keep type narrowing inside the
    // retry closure below, so alias the narrowed client.
    const gemini = geminiClient;

    const contents = [
      ...recentHistory.map((item) => ({
        role:
          item.role === "assistant"
            ? ("model" as const)
            : ("user" as const),
        parts: [
          {
            text: item.content,
          },
        ],
      })),

      {
        role: "user" as const,
        parts: [
          {
            text: correctiveNote
              ? `${correctiveNote}\n\nGuest question:\n${message}`
              : message,
          },
        ],
      },
    ];

    const systemInstruction =
      this.buildSystemInstruction({
        hotelName:
          hotelData.property.name,
        evidence,
        evidenceAvailable,
        timezone: hotelData.property.timezone,
      });

    const response = await withGeminiRetry(
      () =>
        gemini.models.generateContent({
          model: GEMINI_MODEL,
          contents,
          config: {
            systemInstruction,
            temperature: 0.1,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            tools: [
              availabilityTool,
            ],
          },
        }),
      requestId,
      "gemini_agent",
    );

    const functionCall =
      response.functionCalls?.find(
        (call) =>
          call.name ===
          "checkAvailability",
      );

    const tokensIn = response.usageMetadata?.promptTokenCount;
    const tokensOut = response.usageMetadata?.candidatesTokenCount;

    let rawDecision: unknown;

    if (functionCall) {
      rawDecision = {
        type: "check_availability",
        args: functionCall.args ?? {},
        tokensIn,
        tokensOut,
        model: GEMINI_MODEL,
      };
    } else {
      const text = response.text?.trim();
      if (!text) {
        return {
          type: "fallback",
          reason: "empty_response",
          tokensIn,
          tokensOut,
          model: GEMINI_MODEL,
        };
      }
      rawDecision = {
        type: "answer",
        text,
        tokensIn,
        tokensOut,
        model: GEMINI_MODEL,
      };
    }

    const parsedDecision = AgentDecisionSchema.safeParse(rawDecision);
    if (!parsedDecision.success) {
      return {
        type: "fallback",
        reason: "parse_error",
        tokensIn,
        tokensOut,
        model: GEMINI_MODEL,
      };
    }

    return parsedDecision.data;
  }

  /**
   * -------------------------------------------------------
   * Availability verbalization
   * -------------------------------------------------------
   *
   * Gemini is preferred.
   * Groq is fallback.
   *
   * Neither model gets permission to change the
   * deterministic result.
   */

  private static async generateAvailabilityResponse({
    hotelName,
    userMessage,
    conversationHistory,
    availabilityResult,
    requestId,
  }: {
    hotelName: string;
    userMessage: string;
    conversationHistory: ConversationMessage[];
    availabilityResult: AvailabilityResult;
    requestId: string;
  }): Promise<{
    content: string;
    provider: "gemini" | "groq";
    tokensIn?: number;
    tokensOut?: number;
    model?: string;
  }> {
    const toolResult =
      JSON.stringify(
        availabilityResult,
        null,
        2,
      );

    const historyText =
      conversationHistory
        .map(
          (item) =>
            `${item.role}: ${item.content}`,
        )
        .join("\n");

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const systemInstruction =
      `You are the guest concierge for ${hotelName}.\n\n` +
      `Today's date is ${today}.\n\n` +
      "The availability result below is authoritative.\n" +
      "Generate a concise natural-language response in a warm, luxury concierge tone.\n" +
      "Never modify, calculate, infer, or invent availability.\n" +
      "Never change dates, prices, room counts, capacity, or availability.\n" +
      "Do not claim a reservation was made.\n" +
      "Only state information present in the tool result.\n\n" +
      "FORMATTING RULES:\n" +
      "- Never use Markdown tables. Never use headings. Never use code blocks.\n" +
      "- Allowed Markdown only: **bold**, bullet lists (-), and tasteful emoji.\n" +
      "- List each available room as one short card block: a bold room name line, then " +
      "bullets for capacity, bed type, and price per night from the tool result.\n" +
      "- Close with a one-line gentle next step (dates, guests, or which room they prefer).\n\n" +
      `AUTHORITATIVE TOOL RESULT:\n${toolResult}`;

    /**
     * Groq first (primary).
     */
    if (groqClient) {
      try {
        const completion = await withGroqRetry(
          () =>
            groqClient!.chat.completions.create(
              {
                model: GROQ_MODEL,

                temperature: 0.1,
                max_tokens: MAX_OUTPUT_TOKENS,

                messages: [
                  {
                    role: "system",
                    content:
                      systemInstruction,
                  },

                  {
                    role: "user",
                    content:
                      `Guest question:\n${userMessage}\n\n` +
                      `Recent conversation:\n${
                        historyText || "(none)"
                      }`,
                  },
                ],
              },
              {
                timeout: 15_000,
              },
            ),
          requestId,
          "availability_verbalization_groq",
        );

        const text =
          completion.choices[0]?.message
            ?.content?.trim();

        if (text) {
          logger.info(
            {
              requestId,
              provider: "groq",
            },
            "Availability response generated by Groq",
          );

          return {
            content: text,
            provider: "groq",
            tokensIn: completion.usage?.prompt_tokens,
            tokensOut: completion.usage?.completion_tokens,
            model: GROQ_MODEL,
          };
        }
      } catch (error: unknown) {
        logger.warn(
          {
            requestId,
            err: error,
          },
          "Groq availability verbalization failed; trying Gemini",
        );
      }
    }

    /**
     * Gemini fallback.
     */
    if (geminiClient) {
      // Alias for type narrowing inside the retry closure.
      const gemini = geminiClient;

      try {
        const response =
          await withGeminiRetry(
            () =>
              gemini.models.generateContent(
                {
                  model: GEMINI_MODEL,
                  contents: [
                    {
                      role: "user",
                      parts: [
                        {
                          text:
                            `Guest question:\n${userMessage}\n\n` +
                            `Recent conversation:\n${
                              historyText || "(none)"
                            }`,
                        },
                      ],
                    },
                  ],
                  config: {
                    systemInstruction,
                    temperature: 0.1,
                    maxOutputTokens: MAX_OUTPUT_TOKENS,
                  },
                },
              ),
            requestId,
            "availability_verbalization",
          );

        const text =
          response.text?.trim();

        if (text) {
          return {
            content: text,
            provider: "gemini",
            tokensIn: response.usageMetadata?.promptTokenCount,
            tokensOut: response.usageMetadata?.candidatesTokenCount,
            model: GEMINI_MODEL,
          };
        }
      } catch (error: unknown) {
        logger.error(
          {
            requestId,
            err: error,
          },
          "Gemini availability verbalization failed",
        );
      }
    }

    throw new Error(
      "ALL_LLM_PROVIDERS_UNAVAILABLE",
    );
  }

  /**
   * -------------------------------------------------------
   * Groq agent call (primary)
   * -------------------------------------------------------
   */

  private static async decideWithGroq({
    message,
    recentHistory,
    hotelData,
    evidence,
    evidenceAvailable,
    requestId,
    correctiveNote,
  }: {
    message: string;
    recentHistory: ConversationMessage[];
    hotelData: HotelData;
    evidence: string[];
    evidenceAvailable: boolean;
    requestId: string;
    correctiveNote?: string;
  }): Promise<AgentDecision> {
    if (!groqClient) {
      throw new Error(
        "Groq client is not configured",
      );
    }

    const systemInstruction =
      this.buildSystemInstruction({
        hotelName:
          hotelData.property.name,
        evidence,
        evidenceAvailable,
        timezone: hotelData.property.timezone,
      });

    const messages = [
      {
        role: "system" as const,
        content:
          systemInstruction,
      },

      ...recentHistory.map((item) => ({
        role: item.role,
        content: item.content,
      })),

      {
        role: "user" as const,
        content: correctiveNote
          ? `${correctiveNote}\n\nGuest question:\n${message}`
          : message,
      },
    ];

    const completion = await withGroqRetry(
      () =>
        groqClient!.chat.completions.create(
          {
            model: GROQ_MODEL,

            messages,

            temperature: 0.1,
            max_tokens: MAX_OUTPUT_TOKENS,

            tools: [groqAvailabilityTool],

            tool_choice: "auto",

            parallel_tool_calls: false,
          },
          {
            timeout: 15_000,
          },
        ),
      requestId,
      "groq_agent",
    );

    const responseMessage =
      completion.choices[0]?.message;

    const toolCall =
      responseMessage?.tool_calls?.find(
        (call) =>
          call.type === "function" &&
          call.function.name ===
            "checkAvailability",
      );

    const tokensIn = completion.usage?.prompt_tokens;
    const tokensOut = completion.usage?.completion_tokens;

    let rawDecision: unknown;

    if (toolCall) {
      let args: unknown;

      try {
        args = JSON.parse(
          toolCall.function.arguments,
        );
      } catch {
        return {
          type: "fallback",
          reason: "invalid_tool_arguments_json",
          tokensIn,
          tokensOut,
          model: GROQ_MODEL,
        };
      }

      /**
       * Schema-check the proposed arguments before the
       * deterministic service sees them. Value rules
       * (real dates, ordering, bounds) remain in
       * AvailabilityService.
       */
      const parsedArgs =
        GroqToolArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return {
          type: "fallback",
          reason: "invalid_tool_arguments_schema",
          tokensIn,
          tokensOut,
          model: GROQ_MODEL,
        };
      }

      rawDecision = {
        type: "check_availability",
        args: parsedArgs.data,
        tokensIn,
        tokensOut,
        model: GROQ_MODEL,
      };
    } else {
      const content =
        responseMessage?.content?.trim();

      if (!content) {
        return {
          type: "fallback",
          reason: "empty_response",
          tokensIn,
          tokensOut,
          model: GROQ_MODEL,
        };
      }

      rawDecision = {
        type: "answer",
        text: content,
        tokensIn,
        tokensOut,
        model: GROQ_MODEL,
      };
    }

    const parsedDecision =
      AgentDecisionSchema.safeParse(rawDecision);

    if (!parsedDecision.success) {
      return {
        type: "fallback",
        reason: "parse_error",
        tokensIn,
        tokensOut,
        model: GROQ_MODEL,
      };
    }

    return parsedDecision.data;
  }

  /**
   * -------------------------------------------------------
   * Deterministic availability rendering
   * -------------------------------------------------------
   *
   * Used when the LLM verbalization fails numeric verification:
   * every figure comes straight from the tool result, so this
   * text can always be shown with zero hallucination risk.
   */
  private static renderAvailabilityDeterministically(
    result: AvailabilityResult,
  ): string {
    if (!result.available || result.rooms.length === 0) {
      return `📋 ${result.message} Try different dates and I'll check again.`;
    }

    const roomLines = result.rooms
      .map((room) => {
        const beds = room.beds
          .map((bed) => `${bed.count} ${bed.type}`)
          .join(" + ");

        return (
          `- **${room.name}** — up to ${room.maxOccupancy} guests · ` +
          `${beds} · ${room.currency} ${room.pricePerNight}/night · ` +
          `${room.availableRooms} room(s) remaining`
        );
      })
      .join("\n");

    return (
      `📋 Availability for ${result.checkIn} to ${result.checkOut} · ` +
      `${result.adults} adult(s):\n\n${roomLines}\n\n` +
      `💡 Tell me which room you'd like and I'll help with the next steps!`
    );
  }

  /**
   * -------------------------------------------------------
   * System instruction
   * -------------------------------------------------------
  */

  private static buildSystemInstruction({
    hotelName,
    evidence,
    evidenceAvailable,
    timezone,
  }: {
    hotelName: string;
    evidence: string[];
    evidenceAvailable: boolean;
    timezone: string;
  }): string {
    const evidenceBlock =
      evidence.length > 0
        ? evidence
            .map(
              (item, index) =>
                `[Evidence ${index + 1}] ${item}`,
            )
            .join("\n")
        : "(No verified evidence found.)";

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    return `
You are the virtual guest concierge for ${hotelName}.

Today's date is ${today} (timezone: ${timezone}).

Your responsibilities:

1. Answer hotel knowledge questions using ONLY verified evidence.
2. Use checkAvailability when the guest asks about availability or booking availability.

CRITICAL RULES:

- Never invent hotel facts.
- Never invent prices.
- Never invent policies.
- Never invent amenities.
- Never invent room features.
- Never calculate or guess availability.
- Availability must come from checkAvailability.
- The backend is the final authority for availability.
- If required availability information is missing, ask for it.
- Never assume dates. Use today's date as reference for relative date phrases.
- Never assume guest count.
- Use conversation history when appropriate.
- Do not use general world knowledge as hotel-specific information.
- If evidence is insufficient, do not answer from memory.
- Keep responses concise.
- When calling checkAvailability, always parse relative date phrases (e.g. "Oct 10", "Oct 10 to Oct 12") using today's date as the reference year.

RESPONSE FORMAT (luxury concierge style):

- Write for a boutique-hotel chat feed: warm, concise, elegantly formatted.
- Never use Markdown tables. Never use headings (#). Never use code blocks.
- Allowed Markdown only: **bold**, bullet lists (-), and tasteful emoji section markers.
- When presenting TWO OR MORE rooms, use one card block per room, exactly this shape:

Here is a quick overview of our room collections at ${hotelName}:

🏨 **DELUXE ROOM · Classic Comfort**
Capacity: Up to 2 Guests
Breakfast: Optional ($20 / guest / day)
Highlights: <features from evidence, joined with " · ">
Ideal for: <guests this room suits, from evidence>

✨ **EXECUTIVE SUITE · Most Popular**
...

- Each card MUST include all four labels: Capacity / Breakfast / Highlights / Ideal for.
- Choose the emoji marker per room (e.g. 🏨 🏡 ✨ 🌴) and keep the room name in CAPS with a short " · " tagline.
- After the room cards, add a short "🌿 **All Rooms Include:**" bullet list ONLY for amenities that appear in the evidence for every listed room.
- Close with a one-line gentle call-to-action (e.g. 💡 Ready to check availability? Tell me your dates and party size!).
- For SINGLE-room or non-room questions, answer in 1–3 short sentences or a small bullet list; do not force the card layout.
- Every fact you state must come from the evidence below. If the evidence lacks a card field, write that line from what the evidence does support or omit it — never invent.

VERIFIED HOTEL EVIDENCE:

${evidenceBlock}

EVIDENCE SUFFICIENT:
${evidenceAvailable ? "YES" : "NO"}
`;
  }

  /**
   * -------------------------------------------------------
   * Knowledge retrieval
   * -------------------------------------------------------
   */

  private static retrieveKnowledge(
    query: string,
    hotelData: HotelData,
  ): {
    evidence: string[];
    score: number;
  } {
    const tokens =
      this.tokenize(query);

    if (tokens.length === 0) {
      return {
        evidence: [],
        score: 0,
      };
    }

    const scored: Array<{
      content: string;
      score: number;
    }> = [];

    /**
     * -----------------------------------------------
     * Deterministic capacity matching
     * -----------------------------------------------
     */

    const requestedCapacity =
      this.extractRequestedCapacity(
        query,
      );

    if (
      requestedCapacity !== null
    ) {
      const eligibleRooms =
        hotelData.rooms.filter(
          (room) =>
            room.maxOccupancy >=
            requestedCapacity,
        );

      if (
        eligibleRooms.length > 0
      ) {
        const description =
          eligibleRooms
            .map(
              (room) =>
                `${room.name} ` +
                `(maximum ${room.maxOccupancy} guests, ` +
                `beds: ${this.formatBeds(room)}, ` +
                `price: ${room.currency} ${room.pricePerNight}/night)`,
            )
            .join("; ");

        scored.push({
          content:
            `Deterministic room match for ` +
            `${requestedCapacity} guest(s): ${description}.`,
          score: 1,
        });
      }
    }

    /**
     * -----------------------------------------------
     * Direct room-name entity lookup
     * -----------------------------------------------
     *
     * When the guest mentions a room by name (e.g.
     * "EXECUTIVE SUITE", "Deluxe Room", "Family Suite")
     * or badge ("Most Popular"), bypass keyword overlap
     * scoring and emit a high-confidence evidence item
     * with full room details. This prevents failures when
     * the query contains punctuation like · or emoji.
     */

    const normalizedQuery =
      this.normalizeText(query);

    for (const room of hotelData.rooms) {
      const roomName =
        this.normalizeText(room.name);

      const roomId =
        this.normalizeText(room.id);

      const badge = room.badge
        ? this.normalizeText(room.badge)
        : "";

      const mentionsRoom =
        normalizedQuery.includes(roomName) ||
        normalizedQuery.includes(roomId) ||
        (badge !== "" &&
          normalizedQuery.includes(badge));

      if (mentionsRoom) {
        const bedStr =
          this.formatBeds(room);

        const featuresStr =
          room.features.join(", ");

        const badgeStr = room.badge
          ? ` ${room.badge}`
          : "";

        scored.push({
          content:
            `${room.name}${badgeStr}: ` +
            `accommodates up to ${room.maxOccupancy} guests, ` +
            `beds: ${bedStr}, ` +
            `${room.sizeSqm} m², ` +
            `${room.currency} ${room.pricePerNight}/night. ` +
            `Breakfast included: ${room.breakfastIncluded ? "yes" : "no"}. ` +
            `Features: ${featuresStr}. ` +
            `${room.description}`,
          score: 1,
        });
      }
    }

    /**
     * -----------------------------------------------
     * Direct amenity-name entity lookup
     * -----------------------------------------------
     *
     * Same approach as rooms: if the guest mentions an
     * amenity or service by name, emit full details
     * regardless of keyword scoring.
     */

    const services =
      hotelData.services ?? [];

    const allServiceLike = [
      ...hotelData.amenities,
      ...services,
    ];

    for (const item of allServiceLike) {
      const itemName =
        this.normalizeText(item.name);

      if (
        normalizedQuery.length >= 3 &&
        itemName.length >= 3 &&
        normalizedQuery.includes(itemName)
      ) {
        scored.push({
          content:
            `${item.name}: ${item.description}`,
          score: 0.9,
        });
      }
    }

    /**
     * -----------------------------------------------
     * Property
     * -----------------------------------------------
     */

    const property =
      hotelData.property;

    const propertyText = [
      property.name,
      property.description,
      property.address.line1,
      property.address.city,
      property.address.state,
      property.address.country,
      property.contact.phone,
      property.contact.email,
      property.checkInTime,
      property.checkOutTime,
      property.timezone,
      property.currency,
      ...property.keywords,
    ].join(" ");

    const propertyScore =
      this.calcOverlap(
        tokens,
        propertyText,
      );

    if (propertyScore > 0) {
      scored.push({
        content:
          `${property.name}: ${property.description} ` +
          `Check-in: ${property.checkInTime}. ` +
          `Check-out: ${property.checkOutTime}.`,
        score: propertyScore,
      });
    }

    /**
     * -----------------------------------------------
     * Rooms
     * -----------------------------------------------
     */

    for (const room of hotelData.rooms) {
      const beds =
        this.formatBeds(room);

      const searchableText = [
        room.id,
        room.name,
        room.description,
        room.view ?? "",
        room.badge ?? "",
        String(room.maxOccupancy),
        String(room.pricePerNight),
        room.currency,
        String(room.sizeSqm),
        room.breakfastIncluded
          ? "breakfast included"
          : "breakfast not included",
        beds,
        ...room.features,
        ...room.keywords,
      ].join(" ");

      const score =
        this.calcOverlap(
          tokens,
          searchableText,
        );

      if (score > 0) {
        scored.push({
          content:
            `${room.name} accommodates up to ` +
            `${room.maxOccupancy} guests. ` +
            `Beds: ${beds}. ` +
            `Price: ${room.currency} ${room.pricePerNight} per night. ` +
            `Breakfast included: ${
              room.breakfastIncluded
                ? "yes"
                : "no"
            }. ` +
            room.description,
          score,
        });
      }
    }

    /**
     * -----------------------------------------------
     * Amenities
     * -----------------------------------------------
     */

    for (const amenity of hotelData.amenities) {
      const searchableText = [
        amenity.id,
        amenity.name,
        amenity.type,
        amenity.description,
        JSON.stringify(
          amenity.details,
        ),
        ...amenity.keywords,
      ].join(" ");

      const score =
        this.calcOverlap(
          tokens,
          searchableText,
        );

      if (score > 0) {
        scored.push({
          content:
            `${amenity.name}: ${amenity.description}`,
          score,
        });
      }
    }

    /**
     * -----------------------------------------------
     * Policies
     * -----------------------------------------------
     */

    for (const policy of hotelData.policies) {
      const searchableText = [
        policy.id,
        policy.title,
        policy.policy,
        JSON.stringify(
          policy.rules ?? {},
        ),
        ...policy.keywords,
      ].join(" ");

      const score =
        this.calcOverlap(
          tokens,
          searchableText,
        );

      if (score > 0) {
        scored.push({
          content:
            `${policy.title}: ${policy.policy}`,
          score,
        });
      }
    }

    /**
     * -----------------------------------------------
     * FAQs
     * -----------------------------------------------
     */

    for (const faq of hotelData.faqs) {
      const searchableText = [
        faq.id,
        faq.question,
        faq.answer,
        ...faq.keywords,
        ...(faq.relatedRoomIds ?? []),
        faq.relatedPolicyId ?? "",
        faq.relatedAmenityId ?? "",
      ].join(" ");

      const score =
        this.calcOverlap(
          tokens,
          searchableText,
        );

      if (score > 0) {
        scored.push({
          content:
            `${faq.question} ${faq.answer}`,
          score,
        });
      }
    }

    /**
     * Highest confidence first.
     */
    scored.sort(
      (a, b) => b.score - a.score,
    );

    const top =
      scored.slice(
        0,
        MAX_EVIDENCE_ITEMS,
      );

    const bestMatch = top[0];

    return {
      evidence: top.map(
        (item) => item.content,
      ),
      score:
        bestMatch?.score ?? 0,
    };
  }

  /**
   * -------------------------------------------------------
   * Capacity extraction
   * -------------------------------------------------------
   */

  private static extractRequestedCapacity(
    query: string,
  ): number | null {
    const numericMatch =
      query.match(
        /\b(\d+)\s*(?:guest|guests|people|adult|adults|person|persons)\b/i,
      );

    if (numericMatch?.[1]) {
      const count = Number(
        numericMatch[1],
      );

      if (
        Number.isInteger(count) &&
        count > 0 &&
        count <= 20
      ) {
        return count;
      }
    }

    const wordMatch =
      query.match(
        /\b(one|two|three|four|five|six)\s*(?:guest|guests|people|adult|adults|person|persons)\b/i,
      );

    if (wordMatch?.[1]) {
      const values: Record<
        string,
        number
      > = {
        one: 1,
        two: 2,
        three: 3,
        four: 4,
        five: 5,
        six: 6,
      };

      return (
        values[
          wordMatch[1].toLowerCase()
        ] ?? null
      );
    }

    return null;
  }

   /**
    * -------------------------------------------------------
    * Normalize text for fuzzy matching
    * -------------------------------------------------------
    *
    * Lowercases, strips punctuation (including · and emoji),
    * collapses whitespace, and collapses internal spacing so
    * that "EXECUTIVE SUITE · Most Popular" matches the stored
    * room name "Executive Suite" and badge "Most Popular".
    */

  private static normalizeText(
    text: string,
  ): string {
    return text
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}\s]/gu,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
    * -------------------------------------------------------
    * Tokenizer
    * -------------------------------------------------------
    *
    * Keeps numbers such as "2", "3", "4".
    */

  private static tokenize(
    query: string,
  ): string[] {
    const stopwords = new Set([
      "a", "an", "and", "are", "as", "at", "be", "been", "by", "can", "did", "do", "does",
      "for", "from", "has", "have", "had", "he", "her", "him", "his", "hotel", "how", "i", "if", "in",
      "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "out", "over", "she",
      "so", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to",
      "was", "we", "were", "what", "when", "where", "which", "who", "will", "with", "would",
      "you", "your", "yours", "he", "him", "his", "she", "her", "hers", "it", "its", "we",
      "us", "our", "ours", "they", "them", "their", "theirs", "that", "this", "these", "those",
      "am", "been", "being", "do", "did", "does", "doing", "have", "has", "had", "having",
    ]);

    return query
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}\s-]/gu,
        " ",
      )
      .split(/\s+/)
      .filter(
        (token) =>
          (token.length > 2 && !stopwords.has(token)) ||
          /^\d+$/.test(token),
      );
  }

  /**
   * -------------------------------------------------------
   * Whole-word lexical scoring
   * -------------------------------------------------------
   */

  private static calcOverlap(
    tokens: string[],
    text: string,
  ): number {
    if (tokens.length === 0) {
      return 0;
    }

    const normalizedText =
      text.toLowerCase();

    const uniqueTokens =
      new Set(tokens);

    let hits = 0;

    for (const token of uniqueTokens) {
      const escapedToken =
        token.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );

      const regex =
        new RegExp(
          `\\b${escapedToken}\\b`,
          "i",
        );

      if (
        regex.test(normalizedText)
      ) {
        hits++;
      }
    }

    return (
      hits / uniqueTokens.size
    );
  }

  /**
   * -------------------------------------------------------
   * Structured bed formatter
   * -------------------------------------------------------
   */

  private static formatBeds(
    room: Room,
  ): string {
    return room.beds
      .map(
        (bed) =>
          `${bed.count} ${bed.type}`,
      )
      .join(", ");
  }
}
