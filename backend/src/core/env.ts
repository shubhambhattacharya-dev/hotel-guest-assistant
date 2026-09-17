import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Environment loading.
 *
 * This module MUST be the first import in index.ts.
 *
 * Several modules capture process.env values at module scope
 * (core/logger.ts reads NODE_ENV/LOG_LEVEL, services/agentOrchestrator.ts and
 * services/llmClient.ts read their API keys). ES modules are evaluated
 * depth-first in import order, so calling dotenv.config() inside the index.ts
 * body would run too late — those modules would already have evaluated with an
 * empty environment.
 *
 * This module therefore imports nothing that reads process.env.
 *
 * Precedence (lowest to highest):
 *   .env values < ambient environment (shell/OS/container)
 *
 * This is standard dotenv behavior (`override: false`): variables the
 * operator sets in the real environment must win, or deployment
 * configuration such as PORT becomes impossible to override
 * (proven in review: `PORT=8100 npx tsx src/index.ts` was silently
 * ignored because the .env re-set PORT).
 *
 * Stale machine-level variables are deliberately NOT overwritten by
 * the .env file. If a variable from the ambient environment shadows
 * the project's key, inspect it with `printenv GEMINI_API_KEY`
 * rather than working around it here.
 *
 * The .env files are excluded from the Docker image (.dockerignore) and the
 * production stage never copies them, so container/CI injected variables are
 * unaffected by the loading below.
 */

const ENV_CANDIDATES = [
  // Repository root, loaded first so a more specific file can override it.
  path.join(process.cwd(), "..", ".env"),

  // Backend-local overrides win over everything.
  path.join(process.cwd(), ".env"),
];

for (const envPath of ENV_CANDIDATES) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

if (!process.env.GROQ_API_KEY && process.env.GRPQ_API_KEY) {
  process.env.GROQ_API_KEY = process.env.GRPQ_API_KEY;
}
