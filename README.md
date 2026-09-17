# Hotel Guest Assistant

AI-powered guest assistant for a hotel website. Guests can ask property questions, compare rooms, understand policies, and check room availability through a conversational web interface.

## What This Solves

Hotel guests often need quick answers before booking: check-in time, breakfast, pool access, cancellation rules, room fit, and availability. This app gives them one simple chat surface while keeping hotel facts and availability grounded in trusted backend data.

## Tech Stack

- Frontend: Next.js, React, TypeScript, Tailwind CSS, Playwright
- Backend: Node.js, Express, TypeScript, Zod, Pino, Vitest
- AI providers: Groq primary, Gemini fallback when configured
- Data: local JSON hotel knowledge base plus deterministic mock inventory
- Optional observability: Langfuse and Prometheus metrics

## Architecture

```text
Guest Browser
  -> Next.js chat UI
  -> Express API
  -> Agent orchestrator
       -> hotel JSON retrieval for property facts
       -> deterministic availability service for rooms/dates/guest count
       -> LLM for grounded wording and tool-decision support
  -> structured response back to frontend
```

The core invariant is:

> The assistant must not send hotel facts that are not grounded in retrieved hotel evidence or deterministic tool output.

The LLM can help decide whether a question needs the availability tool and can phrase grounded answers. The backend owns validation, retrieval, date rules, inventory rules, and fallback responses.

## Project Structure

```text
backend/        Express API, orchestrator, services, validation, tests
frontend/       Next.js guest-facing chat UI and Playwright tests
data/           Hotel knowledge base JSON
design/         Product/architecture design PDF source and output
docker-compose.yml
```

## Requirements

- Node.js 20+
- npm
- Optional: Groq or Gemini API key for live LLM responses

> **Note**: The app requires at least one active LLM provider key to answer guest questions.
> Without a configured key the backend returns HTTP 503 (`llm_not_configured`) for all `/api/chat` requests.
> Room availability checks remain fully deterministic and do not require an LLM key.

## Environment

Copy the example file and add real keys only if you want live model calls:

```bash
cp .env.example .env
```

Important variables:

```bash
PORT=8000
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Never commit `.env`.

## Local Setup

Install backend dependencies:

```bash
cd backend
npm install
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

Run the backend:

```bash
cd backend
npm run dev
```

Run the frontend in another terminal:

```bash
cd frontend
npm run dev
```

Open:

```text
http://localhost:3000
```

## Docker

```bash
docker compose up --build
```

Frontend:

```text
http://localhost:3000
```

Backend:

```text
http://localhost:8000
```

## API Examples

Health:

```bash
curl http://localhost:8000/health
```

Read hotel data:

```bash
curl http://localhost:8000/api/hotel
```

Ask a guest question:

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"What time is check-in?\"}"
```

Ask with conversation history:

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"And what about check-out?\",\"history\":[{\"role\":\"user\",\"content\":\"What time is check-in?\"},{\"role\":\"assistant\",\"content\":\"Check-in starts at 3:00 PM.\"}]}"
```

Check availability:

```bash
curl -X POST http://localhost:8000/api/availability \
  -H "Content-Type: application/json" \
  -d "{\"checkIn\":\"2026-10-10\",\"checkOut\":\"2026-10-12\",\"adults\":2}"
```

## Testing

Backend unit/API tests:

```bash
cd backend
npm test
```

Backend type check/build:

```bash
cd backend
npm run build
```

Frontend production build:

```bash
cd frontend
npm run build
```

End-to-end tests:

```bash
cd frontend
npm run test:e2e
```

Playwright is configured to start or reuse the backend and frontend dev servers automatically.

## Evaluation Scenarios

Covered by automated tests and manual verification:

1. Normal property question: "What time is check-in?"
2. Amenity question: "Do you have a swimming pool?"
3. Policy question: "What is the cancellation policy?"
4. Room fit question: "Which room is good for 3 guests?"
5. Room detail question: "Tell me about the Executive Suite."
6. Availability with all details: dates plus adults.
7. Availability with missing dates: inline date/guest form is shown.
8. Unsupported assumption: unknown services fall back safely.
9. Greeting/small talk: scripted response without evidence retrieval.
10. Follow-up question: recent conversation context is sent to the backend.
11. Frontend error state: failed API call shows a clear error.
12. Mobile layout: chat remains usable on a narrow screen.
13. Ambiguous reference: "Is it included?" returns a clarification question when no prior topic exists.

### Observed Results

Last verified on 2026-09-17:

| Check | Command | Observed result |
| --- | --- | --- |
| Backend type check | `cd backend && npm run build` | Passed |
| Backend unit/API tests | `cd backend && npm test` | **98 passed**, 5 skipped; the 5 skipped are live LLM integration tests gated behind real provider credentials. A separate `mockedLlm.test.ts` file covers those 5 paths deterministically. |
| Frontend lint | `cd frontend && npm run lint` | Passed |
| Frontend production build | `cd frontend && npm run build` | Passed |
| Browser E2E | `cd frontend && npm run test:e2e` | Requires both backend and frontend dev servers running on ports 8000 and 3000 respectively |
| Golden dataset | `eval/golden.json` | 14 scenarios; adversarial/injection, normal FAQ, ambiguous reference, availability, fallback, and follow-up cases |

The 5 skipped backend tests make live HTTP calls to Gemini/Groq and require real provider keys (`GEMINI_API_KEY` or `GROQ_API_KEY`). All other paths — deterministic availability, input validation, ambiguity detection, prompt-injection guards, and the 5 mocked-LLM chat scenarios — pass in CI without credentials.

## AI And Deterministic Boundaries

AI is used for:

- Conversational wording.
- Deciding when a guest is asking for availability.
- Interpreting natural-language questions against retrieved hotel evidence.

Deterministic backend logic is used for:

- Input validation.
- Date order and past-date checks.
- Guest-capacity limits.
- Mock inventory checks.
- Hotel knowledge retrieval.
- Fallbacks when the answer is unsupported.

## Failure Handling

- If no LLM provider is configured (missing `GEMINI_API_KEY`/`GROQ_API_KEY`), AI-backed questions return an honest HTTP 503 with code `llm_not_configured` — the backend never fabricates an answer from raw evidence.
- If every configured provider fails, the backend returns HTTP 503 with code `all_llm_providers_failed`.
- Deterministic features (greetings, the availability-detail form) keep working without any provider.
- If retrieved evidence is insufficient, the assistant returns a safe fallback instead of inventing facts.
- If an availability request is missing dates or party size, the frontend displays a form.
- If the API call fails, the UI displays the server's error message; for network failures it shows a connection error.
- If a model proposes invalid tool arguments, the backend validates and rejects them.
- Note: provider clients are built once at backend startup, so changing API keys requires a backend restart.

## How To Measure Usefulness

Useful production metrics would include:

- Question resolution rate.
- Availability form completion rate.
- Booking handoff clicks after room results.
- Fallback rate for unsupported questions.
- Average response latency.
- Guest satisfaction or thumbs-up/down feedback.
- Top unanswered questions to improve the knowledge base.

## Production Improvements

- Replace mock inventory with a PMS or booking-engine adapter.
- Add authentication and admin tools for hotel data updates.
- Add persisted conversation storage in Redis or a database.
- Add source citations or "based on hotel policy" labels in the UI.
- Add monitoring dashboards and alerting.
- Add CI to run backend tests, frontend build, and Playwright tests.
- Add accessibility audit and keyboard navigation pass.

## AI Tools Used

- Kilo AI assistant was used for code review, test planning, and implementation support during this assignment.
- The earlier design/scaffolding notes record ZCode CLI with a GLM model; those decisions were reviewed and retained only where they matched this architecture.
- Runtime AI providers are Groq and Gemini, configured server-side. The browser never receives provider keys or calls an LLM directly.

## Repository Status

The repository remote is configured for `hotel-guest-assistant`. Source, tests, data, design notes, Docker configuration, and evaluation data are present locally. Commit and push remain submission actions for the repository owner.
