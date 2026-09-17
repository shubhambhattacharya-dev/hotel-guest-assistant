// Test environment setup
// Do not load live credentials from .env files during automated tests.
// Safe fallback stub values are provided so modules requiring strings initialize cleanly.
process.env.NODE_ENV = "test";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-stub-gemini";
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY ?? "test-stub-groq";
