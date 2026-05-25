# Apollo Agent

Apollo is a mission-control interface for autonomous intelligence. Users give Apollo a goal; Apollo plans, executes, reviews and learns through a controlled multi-agent runtime.

## Launch Stack

- App: TanStack Start, React 19, TypeScript, Tailwind, shadcn-style primitives
- Hosting: Cloudflare Workers/Pages via Wrangler
- Database: Supabase Postgres
- Auth: Supabase Auth with row-level security
- Memory MVP: Supabase Postgres tables, then pgvector
- AI runtime: direct provider APIs with BYOK fallback
- Voice: ElevenLabs
- Later queues: Upstash Redis or BullMQ + Redis
- Later vector scale: Qdrant Cloud

## Why This Stack

Supabase is the best launch database for Apollo because it gives us Postgres, Auth, RLS, Storage, Realtime, Edge Functions and migrations in one free-tier-friendly platform. Apollo already depends on Supabase, so launching there reduces operational drag.

The first launch should avoid extra infrastructure unless it directly improves the product. Use Supabase for structured memory and mission telemetry now; add Qdrant and Redis only when mission volume justifies them.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Fill `.env` with your Supabase and AI provider credentials.

## Database

Apply migrations from `supabase/migrations` to your Supabase project.

Current launch tables include:

- `profiles`
- `api_keys`
- `conversations`
- `messages`
- `missions`
- `mission_phases`
- `memories`
- `voice_sessions`
- `projects`
- `user_preferences`
- `mission_runs`
- `mission_costs`
- `prompt_versions`
- `orchestration_learning`

## Deployment

```bash
npm run build
```

Deploy with Cloudflare using the app name in `wrangler.jsonc`: `apollo-agent`.

Set production secrets in Cloudflare:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_AI_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `APOLLO_EXTRACT_PROVIDER=openrouter`
- `APOLLO_EXTRACT_MODEL=openrouter/owl-alpha`
- `ELEVENLABS_API_KEY`

Set client build variables:

- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

## Launch Readiness

Before launch:

- Apply Supabase migrations.
- Verify RLS policies in Supabase.
- Configure allowed auth redirect URLs:
  - `http://localhost:5173/auth/callback`
  - `https://your-domain.com/auth/callback`
- Configure Cloudflare environment variables.
- Run `npm run build`.
- Create one test user and launch a mission.
- Confirm Planner, Implementer and Reviewer phases stream correctly.
- Confirm `.env` is never committed.
