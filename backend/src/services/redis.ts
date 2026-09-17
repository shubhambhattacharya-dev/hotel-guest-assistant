import RedisDefault from "ioredis";
import logger from "../core/logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Redis = RedisDefault as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

let redis: RedisClient | null = null;

export function initializeRedis(): RedisClient | null {
  const redisUrl = process.env.REDIS_URL;
  
  if (!redisUrl) {
    logger.warn("REDIS_URL not set, conversation persistence disabled");
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          logger.error("Redis max retries reached");
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redis.on("error", (err: Error) => {
      logger.error({ err }, "Redis connection error");
    });

    redis.on("connect", () => {
      logger.info("Redis connected");
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    redis.connect().catch((err: Error) => {
      logger.error({ err }, "Failed to connect to Redis");
    });

    return redis;
  } catch (error) {
    logger.error({ err: error }, "Failed to initialize Redis");
    return null;
  }
}

export function getRedis(): RedisClient | null {
  return redis;
}

export async function saveConversation(
  conversationId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  ttlSeconds = 86400 * 7 // 7 days
): Promise<void> {
  if (!redis) return;
  
  try {
    await redis.setex(
      `conversation:${conversationId}`,
      ttlSeconds,
      JSON.stringify(messages),
    );
  } catch (error) {
    logger.error({ err: error, conversationId }, "Failed to save conversation");
  }
}

export async function getConversation(
  conversationId: string
): Promise<Array<{ role: "user" | "assistant"; content: string }> | null> {
  if (!redis) return null;
  
  try {
    const data = await redis.get(`conversation:${conversationId}`);
    if (!data) return null;
    return JSON.parse(data);
  } catch (error) {
    logger.error({ err: error, conversationId }, "Failed to get conversation");
    return null;
  }
}

export async function appendToConversation(
  conversationId: string,
  message: { role: "user" | "assistant"; content: string },
  ttlSeconds = 86400 * 7
): Promise<void> {
  if (!redis) return;
  
  try {
    const existing = await getConversation(conversationId);
    const messages = existing ? [...existing, message] : [message];
    await saveConversation(conversationId, messages, ttlSeconds);
  } catch (error) {
    logger.error({ err: error, conversationId }, "Failed to append to conversation");
  }
}