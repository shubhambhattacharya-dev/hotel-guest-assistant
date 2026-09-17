import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";

/**
 * ---------------------------------------------------------------------------
 * LLM PROVIDER CONFIGURATION — single source of truth
 * ---------------------------------------------------------------------------
 *
 * This module is the ONLY place that reads provider API keys and builds
 * provider clients. The agent orchestrator imports the clients from here,
 * and /ready uses checkLLMHealth() — so the health endpoint and the
 * request path can never disagree about which providers are configured.
 *
 * Clients are built once at module load from the environment. Changing
 * GEMINI_API_KEY / GROQ_API_KEY therefore requires a backend restart
 * (a `tsx watch` restart on source edits re-reads the .env; editing the
 * .env alone does not).
 */

export const LLM_CONFIG = {
  gemini: {
    /**
     * gemini-2.5-flash returns 404 ("no longer available to new users") on
     * current API keys, so the default tracks the model the API recommends.
     * Override with GEMINI_MODEL when the account has access to another model.
     */
    model:
      process.env.GEMINI_MODEL ??
      "gemini-3.6-flash",

    apiKey:
      process.env.GEMINI_API_KEY,
  },

  groq: {
    model:
      process.env.GROQ_MODEL ??
      "openai/gpt-oss-120b",

    apiKey:
      process.env.GROQ_API_KEY,
  },

  timeoutMs:
    Number(process.env.LLM_TIMEOUT_MS ?? 15_000),

  maxHistoryMessages: 8,
} as const;

/**
 * Primary agent provider: Gemini handles function calling cleanly
 * through the Google GenAI SDK.
 */
export const geminiClient =
  LLM_CONFIG.gemini.apiKey
    ? new GoogleGenAI({
        apiKey:
          LLM_CONFIG.gemini.apiKey,
      })
    : null;

/**
 * Secondary provider: GPT-OSS 120B serves as both agent fallback
 * and the fast path for grounded generation.
 */
export const groqClient =
  LLM_CONFIG.groq.apiKey
    ? new Groq({
        apiKey:
          LLM_CONFIG.groq.apiKey,
      })
    : null;

export type LLMProvider = "gemini" | "groq";

/**
 * Providers that will actually be attempted for this process.
 */
export function getAvailableProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];

  if (geminiClient) {
    providers.push("gemini");
  }

  if (groqClient) {
    providers.push("groq");
  }

  return providers;
}

/**
 * Liveness for /ready: reports whether at least one provider is
 * configured for this process. This is a configuration check, not a
 * network probe — a wrong/expired key surfaces as provider call
 * failures (and an honest 503 to guests), not here.
 */
export async function checkLLMHealth(): Promise<boolean> {
  return getAvailableProviders().length > 0;
}
