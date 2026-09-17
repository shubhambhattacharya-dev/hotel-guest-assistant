import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Backend tests run in Node.js.
    environment: "node",

    // Load .env before test files execute.
    // Required so LLM credentials are available when
    // api.test.ts determines whether to run LLM tests.
    setupFiles: ["./tests/setup.ts"],

    // Default timeout for deterministic and integration tests.
    // LLM tests can override this per test.
    testTimeout: 10_000,

    // Maximum time allowed for beforeAll/afterAll hooks.
    hookTimeout: 10_000,

    // Retry once only in CI because external LLM providers
    // can occasionally fail due to transient network/rate limits.
    retry: process.env.CI ? 1 : 0,

    // Test files explicitly import describe/it/expect.
    globals: false,

    // Only discover TypeScript test files under tests/.
    include: ["tests/**/*.test.ts"],

    // Never treat dependencies or compiled output as tests.
    exclude: ["node_modules", "dist"],
  },
});