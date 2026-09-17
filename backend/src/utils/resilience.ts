import logger from "../core/logger.js";

export interface CircuitBreakerOptions {
  /**
   * Unique name used in logs/metrics.
   */
  name: string;

  /**
   * Number of consecutive failures required
   * before CLOSED -> OPEN.
   *
   * Default: 3
   */
  failureThreshold?: number;

  /**
   * Time the circuit remains OPEN before allowing
   * a recovery probe.
   *
   * Default: 30 seconds.
   */
  resetTimeoutMs?: number;

  /**
   * Number of consecutive successful probes required
   * in HALF_OPEN before returning to CLOSED.
   *
   * Default: 1.
   */
  successThreshold?: number;
}

export type CircuitBreakerState =
  | "CLOSED"
  | "OPEN"
  | "HALF_OPEN";

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;

  /**
   * Consecutive failures while CLOSED.
   */
  consecutiveFailures: number;

  /**
   * Consecutive successful probes while HALF_OPEN.
   */
  consecutiveSuccessesInHalfOpen: number;

  /**
   * Timestamp when the circuit entered OPEN.
   */
  openedAt: number | null;

  /**
   * Most recent dependency error.
   */
  lastError: string | null;
}

/**
 * Error thrown by the circuit breaker itself.
 *
 * This is different from an error thrown by the protected
 * dependency.
 *
 * Example:
 *
 *   try {
 *     await breaker.execute(callGemini);
 *   } catch (error) {
 *     if (error instanceof CircuitOpenError) {
 *       // Do not retry immediately.
 *     }
 *   }
 */
export class CircuitOpenError extends Error {
  public readonly circuitName: string;

  constructor(
    circuitName: string,
    message: string,
  ) {
    super(message);

    this.name = "CircuitOpenError";
    this.circuitName = circuitName;

    Object.setPrototypeOf(
      this,
      CircuitOpenError.prototype,
    );
  }
}

export interface CircuitBreaker {
  execute<T>(
    fn: () => Promise<T>,
  ): Promise<T>;

  getState(): CircuitBreakerState;

  getMetrics(): CircuitBreakerMetrics;

  /**
   * Manual operational reset.
   */
  reset(): void;
}

export function createCircuitBreaker(
  options: CircuitBreakerOptions,
): CircuitBreaker {
  const {
    name,
    failureThreshold = 3,
    resetTimeoutMs = 30_000,
    successThreshold = 1,
  } = options;

  /**
   * -------------------------------------------------------
   * Validate configuration
   * -------------------------------------------------------
   */

  if (!name.trim()) {
    throw new Error(
      "Circuit breaker name is required",
    );
  }

  if (
    !Number.isInteger(failureThreshold) ||
    failureThreshold < 1
  ) {
    throw new Error(
      "failureThreshold must be a positive integer",
    );
  }

  if (
    !Number.isFinite(resetTimeoutMs) ||
    resetTimeoutMs <= 0
  ) {
    throw new Error(
      "resetTimeoutMs must be greater than zero",
    );
  }

  if (
    !Number.isInteger(successThreshold) ||
    successThreshold < 1
  ) {
    throw new Error(
      "successThreshold must be a positive integer",
    );
  }

  /**
   * -------------------------------------------------------
   * Internal state
   * -------------------------------------------------------
   */

  let state: CircuitBreakerState =
    "CLOSED";

  let consecutiveFailures = 0;

  let consecutiveSuccessesInHalfOpen = 0;

  let openedAt: number | null = null;

  let lastError: string | null = null;

  /**
   * Important:
   *
   * In this single Node.js process, this flag prevents
   * multiple concurrent HALF_OPEN probes.
   */
  let halfOpenProbeInFlight = false;

  /**
   * -------------------------------------------------------
   * Helpers
   * -------------------------------------------------------
   */

  function errorMessage(
    error: unknown,
  ): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  function transitionToOpen(
    reason: string,
  ): void {
    state = "OPEN";

    openedAt = Date.now();

    halfOpenProbeInFlight = false;

    consecutiveSuccessesInHalfOpen = 0;

    logger.warn(
      {
        circuit: name,
        failures: consecutiveFailures,
        resetTimeoutMs,
        reason,
      },
      "Circuit breaker opened",
    );
  }

  function transitionToHalfOpen(): void {
    state = "HALF_OPEN";

    consecutiveSuccessesInHalfOpen = 0;

    halfOpenProbeInFlight = false;

    logger.info(
      {
        circuit: name,
      },
      "Circuit breaker entering HALF_OPEN state",
    );
  }

  function transitionToClosed(): void {
    state = "CLOSED";

    consecutiveFailures = 0;

    consecutiveSuccessesInHalfOpen = 0;

    openedAt = null;

    halfOpenProbeInFlight = false;

    lastError = null;

    logger.info(
      {
        circuit: name,
      },
      "Circuit breaker recovered to CLOSED state",
    );
  }

  /**
   * -------------------------------------------------------
   * Success handling
   * -------------------------------------------------------
   */

  function handleSuccess(): void {
    lastError = null;

    /**
     * Normal CLOSED operation.
     */
    if (state === "CLOSED") {
      consecutiveFailures = 0;
      return;
    }

    /**
     * Recovery probe.
     */
    if (state === "HALF_OPEN") {
      consecutiveSuccessesInHalfOpen += 1;

      halfOpenProbeInFlight = false;

      if (
        consecutiveSuccessesInHalfOpen >=
        successThreshold
      ) {
        transitionToClosed();
      }

      /**
       * If successThreshold > 1,
       * remain HALF_OPEN until enough probes succeed.
       */
    }
  }

  /**
   * -------------------------------------------------------
   * Failure handling
   * -------------------------------------------------------
   */

  function handleFailure(
    error: unknown,
  ): void {
    lastError =
      errorMessage(error);

    /**
     * A failed recovery probe means the
     * dependency is still unhealthy.
     *
     * Immediately return to OPEN.
     */
    if (state === "HALF_OPEN") {
      consecutiveSuccessesInHalfOpen = 0;

      halfOpenProbeInFlight = false;

      transitionToOpen(
        "half-open recovery probe failed",
      );

      return;
    }

    /**
     * Normal CLOSED failure.
     */
    consecutiveFailures += 1;

    if (
      consecutiveFailures >=
      failureThreshold
    ) {
      transitionToOpen(
        "failure threshold reached",
      );
    }
  }

  /**
   * -------------------------------------------------------
   * Execute
   * -------------------------------------------------------
   */

  async function execute<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    /**
     * IMPORTANT:
     *
     * Everything before the first await executes
     * synchronously in Node.js.
     *
     * This means the HALF_OPEN transition and
     * probe lock cannot be interleaved by another
     * JavaScript callback.
     */

    /**
     * -----------------------------------------------
     * OPEN
     * -----------------------------------------------
     */

    if (state === "OPEN") {
      if (openedAt === null) {
        /**
         * Defensive recovery in case state was
         * somehow persisted without a timestamp.
         */
        openedAt = Date.now();
      }

      const elapsed =
        Date.now() - openedAt;

      /**
       * Recovery timeout has not elapsed.
       */
      if (
        elapsed < resetTimeoutMs
      ) {
        throw new CircuitOpenError(
          name,
          `Circuit breaker '${name}' is OPEN. Fast-failing.`,
        );
      }

      /**
       * Recovery timeout elapsed.
       *
       * Move into HALF_OPEN.
       */
      transitionToHalfOpen();
    }

    /**
     * -----------------------------------------------
     * HALF_OPEN
     * -----------------------------------------------
     *
     * Only one probe is allowed.
     */

    if (state === "HALF_OPEN") {
      if (halfOpenProbeInFlight) {
        throw new CircuitOpenError(
          name,
          `Circuit breaker '${name}' is HALF_OPEN. Recovery probe already in progress.`,
        );
      }

      halfOpenProbeInFlight = true;
    }

    /**
     * -----------------------------------------------
     * Protected dependency call
     * -----------------------------------------------
     */

    try {
      const result =
        await fn();

      handleSuccess();

      return result;
    } catch (error: unknown) {
      handleFailure(error);

      throw error;
    }
  }

  /**
   * -------------------------------------------------------
   * Public API
   * -------------------------------------------------------
   */

  return {
    execute,

    getState(): CircuitBreakerState {
      return state;
    },

    getMetrics(): CircuitBreakerMetrics {
      return {
        state,

        consecutiveFailures,

        consecutiveSuccessesInHalfOpen,

        openedAt,

        lastError,
      };
    },

    reset(): void {
      state = "CLOSED";

      consecutiveFailures = 0;

      consecutiveSuccessesInHalfOpen = 0;

      openedAt = null;

      halfOpenProbeInFlight = false;

      lastError = null;

      logger.info(
        {
          circuit: name,
        },
        "Circuit breaker manually reset to CLOSED",
      );
    },
  };
}

export default createCircuitBreaker;