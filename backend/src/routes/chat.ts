import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import logger from "../core/logger.js";
import { getHotelDataOrThrow } from "../services/hotelKnowledge.js";
import { AgentOrchestrator, LlmUnavailableError } from "../services/agentOrchestrator.js";
import { getConversation, appendToConversation } from "../services/redis.js";
import { getLangfuse } from "../services/langfuse.js";
import { validateChatRequest } from "../middleware/validation.js";

const router = Router();

router.post("/", validateChatRequest, async (req: Request, res: Response): Promise<void> => {
  const requestId = `req_${randomUUID()}`;
  const startTime = Date.now();

  const { message, conversationId, history } = req.body;

  if (typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({
      error: "Message is required and must be a non-empty string",
      requestId,
    });
    return;
  }

  if (
    conversationId !== undefined &&
    (typeof conversationId !== "string" || conversationId.trim().length === 0)
  ) {
    res.status(400).json({
      error: "conversationId must be a non-empty string if provided",
      requestId,
    });
    return;
  }

  const resolvedConversationId =
    typeof conversationId === "string" && conversationId.trim().length > 0
      ? conversationId
      : randomUUID();

  // Load conversation history from Redis
  const storedHistory = await getConversation(resolvedConversationId);
  const conversationHistory = storedHistory ?? [];

  // Use provided history if no stored history, otherwise merge (client history takes precedence for current session)
  const finalHistory = history && history.length > 0 ? history : conversationHistory;

  logger.info(
    {
      requestId,
      conversationId: resolvedConversationId,
      messageLength: message.length,
      historyMessages: finalHistory.length,
    },
    "Received chat message",
  );

  const langfuse = getLangfuse();
  const trace = langfuse?.trace({
    name: "chat-request",
    input: { message, conversationId: resolvedConversationId, history: finalHistory },
    metadata: { requestId },
  });

  try {
    getHotelDataOrThrow();

    const result = await AgentOrchestrator.processMessage(
      message,
      finalHistory,
      requestId,
    );

    // Save user message and assistant response to Redis
    await appendToConversation(resolvedConversationId, { role: "user", content: message });
    await appendToConversation(resolvedConversationId, { role: "assistant", content: result.content });

    const latencyMs = Date.now() - startTime;

    logger.info(
      {
        requestId,
        conversationId: resolvedConversationId,
        latencyMs,
        model: result.metadata.model ?? null,
        tokensIn: result.metadata.tokensIn ?? 0,
        tokensOut: result.metadata.tokensOut ?? 0,
        retrieval: result.metadata.retrieval ?? null,
        tool: result.metadata.toolUsed
          ? {
              name: result.metadata.toolUsed,
              latencyMs: result.metadata.toolLatencyMs ?? 0,
              ok: Boolean(result.metadata.availabilityData?.available),
            }
          : null,
        fallback: result.metadata.fallback ?? null,
      },
      "Chat request completed",
    );

    // Langfuse trace completion
    trace?.update({
      output: { response: result.content, metadata: result.metadata },
      metadata: { grounded: result.metadata.grounded, toolUsed: result.metadata.toolUsed },
    });

    await langfuse?.flushAsync();

    res.status(200).json({
      conversationId: resolvedConversationId,
      message: {
        role: result.role,
        content: result.content,
      },
      metadata: {
        ...result.metadata,
        requestId,
      },
    });
  } catch (error: unknown) {
    /**
     * No LLM provider configured, or every provider failed.
     * Return 503 with the failure reason so the frontend can
     * show an honest error state — never a fabricated answer.
     */
    if (error instanceof LlmUnavailableError) {
      logger.error(
        {
          err: error,
          requestId,
          conversationId: resolvedConversationId,
          code: error.code,
        },
        "Chat rejected: LLM unavailable",
      );

      trace?.update({
        output: { error: error.code },
        metadata: { error: true, code: error.code },
      });

      await langfuse?.flushAsync();

      res.status(503).json({
        error: error.message,
        code: error.code,
        requestId,
        conversationId: resolvedConversationId,
      });
      return;
    }

    logger.error(
      {
        err: error,
        requestId,
        conversationId: resolvedConversationId,
      },
      "Chat processing failed",
    );

    trace?.update({
      output: { error: "Failed to process chat message" },
      metadata: { error: true },
    });

    await langfuse?.flushAsync();

    res.status(500).json({
      error: "Failed to process chat message",
      requestId,
      conversationId: resolvedConversationId,
    });
  }
});

export default router;
